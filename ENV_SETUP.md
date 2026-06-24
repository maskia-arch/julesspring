# Render Environment Variable Setup für Update 1.6

## Neue Variable: XAI_API_KEY

In deinem Render Service → **Environment** → **Add Environment Variable**:

```
Key:   XAI_API_KEY
Value: xai-xxxxxxxxxxxxxxxxxxxxxxxx
```

Den API-Key bekommst du unter: https://console.x.ai → API Keys → Create API Key

## Alle API-Keys auf einen Blick

| Variable         | Wofür                                    | Pflicht |
|-----------------|------------------------------------------|---------|
| XAI_API_KEY     | Grok Fast, Grok Think, Blacklist Enhancer | NEU ✅  |
| OPENAI_API_KEY  | AutoActsAi Chat/Think, WerbeTexter, Tagesbericht (wenn kein Grok) | Ja |
| DEEPSEEK_API_KEY| AutoActsAi Chat / Think (Smalltalk)      | Ja |

## Wichtig

- Der Key beginnt immer mit `xai-`
- Großschreibung beachten: `XAI_API_KEY` (nicht `xai_api_key`)
- Nach dem Setzen Render-Deploy triggern
