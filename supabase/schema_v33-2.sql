-- Schema v33 (revised): Single package + multiple refills per channel
-- Safe to re-run (idempotent)

-- ── Per-purchase tracking ──────────────────────────────────────────────────────
alter table channel_purchases add column if not exists credits_used    integer not null default 0;
alter table channel_purchases add column if not exists activated_at    timestamptz;
alter table channel_purchases add column if not exists duration_days   integer not null default 30;
alter table channel_purchases add column if not exists forfeited       boolean not null default false;
alter table channel_purchases add column if not exists kind            text;   -- 'package' | 'refill'

-- Backfill for existing rows
update channel_purchases set credits_used = 0 where credits_used is null;
update channel_purchases set duration_days = 30 where duration_days is null or duration_days = 0;
-- Distinguish kind by meta / package_id
update channel_purchases
   set kind = case
              when meta->>'type' = 'refill' then 'refill'
              when package_id is not null   then 'package'
              else 'package'
              end
 where kind is null;

-- Existing legacy "completed" rows:
--   - package: treat as activated at creation (30-day countdown already running)
--   - refill:  activated_at stays null (still lazy)
update channel_purchases set activated_at = created_at
  where status = 'completed' and kind = 'package' and activated_at is null;

create index if not exists idx_cp_channel_kind on channel_purchases (channel_id, kind, status);
create index if not exists idx_cp_activated    on channel_purchases (activated_at);

-- ── RPC: get the currently active package for a channel ───────────────────────
-- Active = status=completed, kind=package, not forfeited, credits_used < credits_added,
--          and (activated_at IS NULL OR activated_at + duration_days > NOW())
create or replace function get_active_package(p_channel_id text)
returns table(
  id            bigint,
  credits_added integer,
  credits_used  integer,
  activated_at  timestamptz,
  expires_at    timestamptz,
  duration_days integer
)
language sql stable
as $$
  select
    cp.id,
    cp.credits_added,
    cp.credits_used,
    cp.activated_at,
    case
      when cp.activated_at is null then null
      else cp.activated_at + make_interval(days => coalesce(cp.duration_days, 30))
    end as expires_at,
    cp.duration_days
  from channel_purchases cp
  where cp.channel_id = p_channel_id
    and cp.status     = 'completed'
    and cp.kind       = 'package'
    and coalesce(cp.forfeited, false) = false
    and cp.credits_used < cp.credits_added
    and (
      cp.activated_at is null
      or cp.activated_at + make_interval(days => coalesce(cp.duration_days, 30)) > now()
    )
  order by cp.created_at desc
  limit 1;
$$;

-- ── RPC: consume credits — package first, then FIFO refills ───────────────────
-- A refill can only be consumed while the package is active (not expired/forfeited).
create or replace function consume_channel_credits(
  p_channel_id text,
  p_tokens     integer
) returns jsonb
language plpgsql
as $$
declare
  v_remaining   integer := p_tokens;
  v_total_used  integer := 0;
  v_now         timestamptz := now();
  v_pkg         record;
  v_pkg_active  boolean := false;
  v_refill      record;
  v_deduct      integer;
begin
  -- 1) Active package: find + deduct
  select * into v_pkg from get_active_package(p_channel_id);

  if v_pkg.id is not null then
    v_pkg_active := true;
    -- Set activated_at if still null (first use)
    if v_pkg.activated_at is null then
      update channel_purchases set activated_at = v_now where id = v_pkg.id;
    end if;
    v_deduct := least(v_remaining, v_pkg.credits_added - v_pkg.credits_used);
    if v_deduct > 0 then
      update channel_purchases
         set credits_used = credits_used + v_deduct
       where id = v_pkg.id;
      v_remaining  := v_remaining  - v_deduct;
      v_total_used := v_total_used + v_deduct;
    end if;
  end if;

  -- 2) Refills: only consume if a package is currently active
  if v_pkg_active and v_remaining > 0 then
    for v_refill in
      select id, credits_added, credits_used, activated_at, duration_days
        from channel_purchases
       where channel_id = p_channel_id
         and status     = 'completed'
         and kind       = 'refill'
         and coalesce(forfeited, false) = false
         and credits_used < credits_added
         and (
           activated_at is null
           or activated_at + make_interval(days => coalesce(duration_days, 30)) > v_now
         )
       order by created_at asc  -- FIFO
       for update
    loop
      exit when v_remaining <= 0;

      if v_refill.activated_at is null then
        update channel_purchases set activated_at = v_now where id = v_refill.id;
      end if;

      v_deduct := least(v_remaining, v_refill.credits_added - v_refill.credits_used);
      if v_deduct > 0 then
        update channel_purchases
           set credits_used = credits_used + v_deduct
         where id = v_refill.id;
        v_remaining  := v_remaining  - v_deduct;
        v_total_used := v_total_used + v_deduct;
      end if;
    end loop;
  end if;

  -- 3) Mirror aggregate into bot_channels for UI / quick budget check
  if v_total_used > 0 then
    update bot_channels
       set token_used = coalesce(token_used, 0) + v_total_used,
           last_active_at = v_now,
           updated_at     = v_now
     where id = p_channel_id;
  end if;

  return jsonb_build_object(
    'consumed',         v_total_used,
    'requested',        p_tokens,
    'remaining_unpaid', v_remaining,
    'package_active',   v_pkg_active
  );
end;
$$;

-- ── RPC: recompute channel budget after activation / expiry ───────────────────
-- When PACKAGE expires → active refills also forfeit (business rule).
create or replace function recompute_channel_budget(p_channel_id text)
returns void
language plpgsql
as $$
declare
  v_now           timestamptz := now();
  v_pkg_active    boolean := false;
  v_pkg_credits   integer := 0;
  v_pkg_used      integer := 0;
  v_pkg_expires   timestamptz;
  v_refill_credits integer := 0;
  v_refill_used   integer := 0;
  v_total_credits integer;
  v_total_used    integer;
begin
  -- Mark expired packages as forfeited
  update channel_purchases
     set forfeited = true
   where channel_id = p_channel_id
     and status     = 'completed'
     and kind       = 'package'
     and coalesce(forfeited, false) = false
     and activated_at is not null
     and activated_at + make_interval(days => coalesce(duration_days, 30)) < v_now;

  -- Check if there is an active package
  select credits_added, credits_used,
         case when activated_at is null then null
              else activated_at + make_interval(days => coalesce(duration_days, 30))
         end
    into v_pkg_credits, v_pkg_used, v_pkg_expires
    from channel_purchases
   where channel_id = p_channel_id
     and status     = 'completed'
     and kind       = 'package'
     and coalesce(forfeited, false) = false
     and credits_used < credits_added
     and (activated_at is null or activated_at + make_interval(days => coalesce(duration_days, 30)) > v_now)
   order by created_at desc
   limit 1;

  v_pkg_active := (v_pkg_credits is not null);

  -- v1.4.47-2: Only ACTIVATED refills (used at least once) are tied to the package's life.
  -- Untouched refills (activated_at IS NULL) survive indefinitely as emergency reserve.
  if not v_pkg_active then
    -- Package expired → forfeit only refills that have already been touched
    update channel_purchases
       set forfeited = true
     where channel_id = p_channel_id
       and status     = 'completed'
       and kind       = 'refill'
       and coalesce(forfeited, false) = false
       and activated_at is not null;
  else
    -- Mark individually expired refills (activated + countdown elapsed)
    update channel_purchases
       set forfeited = true
     where channel_id = p_channel_id
       and status     = 'completed'
       and kind       = 'refill'
       and coalesce(forfeited, false) = false
       and activated_at is not null
       and activated_at + make_interval(days => coalesce(duration_days, 30)) < v_now;
  end if;

  -- Sum refill credits that still contribute to the channel's budget.
  -- While package active: all non-forfeited refills count.
  -- While package inactive: only untouched (activated_at IS NULL) refills remain as reserve.
  if v_pkg_active then
    select
      coalesce(sum(credits_added), 0),
      coalesce(sum(credits_used),  0)
    into v_refill_credits, v_refill_used
    from channel_purchases
    where channel_id = p_channel_id
      and status     = 'completed'
      and kind       = 'refill'
      and coalesce(forfeited, false) = false;
  else
    -- Untouched refills remain as emergency reserve (no package yet, waiting for next one)
    select
      coalesce(sum(credits_added), 0),
      0
    into v_refill_credits, v_refill_used
    from channel_purchases
    where channel_id = p_channel_id
      and status     = 'completed'
      and kind       = 'refill'
      and coalesce(forfeited, false) = false
      and activated_at is null;
  end if;

  v_total_credits := coalesce(v_pkg_credits, 0) + coalesce(v_refill_credits, 0);
  v_total_used    := coalesce(v_pkg_used,    0) + coalesce(v_refill_used,    0);

  update bot_channels
     set token_limit            = v_total_credits,
         token_used             = v_total_used,
         credits_expire_at      = v_pkg_expires,   -- package expiry governs both
         token_budget_exhausted = (v_total_credits > 0 and v_total_used >= v_total_credits),
         ai_enabled             = (v_total_credits > 0 and v_total_used <  v_total_credits),
         updated_at             = v_now
   where id = p_channel_id;
end;
$$;

-- ── RPC: hourly sweeper — expire all packages & their refills ─────────────────
create or replace function expire_channel_packages() returns integer
language plpgsql
as $$
declare
  v_expired_channels text[];
  v_channel text;
  v_count integer := 0;
begin
  -- Collect channels with newly expired packages
  select array_agg(distinct channel_id) into v_expired_channels
    from channel_purchases
   where status     = 'completed'
     and kind       = 'package'
     and coalesce(forfeited, false) = false
     and activated_at is not null
     and activated_at + make_interval(days => coalesce(duration_days, 30)) < now();

  if v_expired_channels is null then return 0; end if;

  foreach v_channel in array v_expired_channels loop
    perform recompute_channel_budget(v_channel);
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;
