const supabase = require('../config/supabase');
const logger = require('../utils/logger');

const abuseFilter = async (req, res, next) => {
  try {
    const telegramId = req.body.message?.from?.id?.toString();
    const webFingerprint = req.body.fingerprint;
    const ipAddress = req.ip || req.headers['x-forwarded-for'];

    const identifiers = [telegramId, webFingerprint, ipAddress].filter(Boolean);

    if (identifiers.length === 0) {
      return next();
    }

    const { data: bannedEntry, error } = await supabase
      .from('blacklist')
      .select('identifier, reason')
      .in('identifier', identifiers)
      .limit(1);

    if (error) throw error;

    if (bannedEntry && bannedEntry.length > 0) {
      logger.warn(`Blockierter Zugriffversuch - Identifikator: ${bannedEntry[0].identifier} | Grund: ${bannedEntry[0].reason || 'Nicht angegeben'}`);
      
      if (req.body.message?.chat?.id) {
        return res.status(200).send(); 
      }
      
      return res.status(403).json({ 
        error: 'Zugriff verweigert', 
        message: 'Dein Zugang wurde aufgrund von Richtlinienverstößen gesperrt.' 
      });
    }

    next();
  } catch (error) {
    logger.error('AbuseFilter Error:', error.message);
    next();
  }
};

module.exports = abuseFilter;
