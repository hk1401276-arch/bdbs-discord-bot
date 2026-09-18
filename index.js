require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const express = require('express');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.GuildMember],
});

const app = express();
app.use(express.json());

function checkSecret(req, res) {
  const secret = req.headers['x-webhook-secret'];
  if (secret !== process.env.WEBHOOK_SECRET) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}

/**
 * Normalize Discord username input
 * Accepts: "name", "@name", "name#1234" (old), display name, etc.
 */
function normalizeUsername(input) {
  if (!input) return '';
  let s = String(input).trim();
  s = s.replace(/^@/, '');
  // strip old discriminator if present
  if (s.includes('#')) {
    s = s.split('#')[0];
  }
  return s.toLowerCase().trim();
}

async function findMember(guild, discord_id, discord_username) {
  let member = null;

  // 1) Prefer exact ID fetch
  if (discord_id) {
    try {
      member = await guild.members.fetch(String(discord_id));
      if (member) return member;
    } catch (e) {
      console.log('fetch by id failed:', discord_id, e.message);
    }
  }

  // 2) Search by username / globalName / displayName
  if (discord_username) {
    try {
      // Ensure members are cached (requires GuildMembers intent + privileged)
      await guild.members.fetch();
    } catch (e) {
      console.log('guild.members.fetch() warning:', e.message);
    }

    const uname = normalizeUsername(discord_username);
    if (!uname) return null;

    member = guild.members.cache.find((m) => {
      const u = m.user;
      const candidates = [
        u.username,
        u.globalName,
        m.displayName,
        m.nickname,
      ]
        .filter(Boolean)
        .map((x) => String(x).toLowerCase().trim());

      return candidates.includes(uname);
    });
  }

  return member || null;
}

function memberToProfile(member) {
  const avatarUrl = member.user.displayAvatarURL({
    size: 256,
    extension: 'png',
    forceStatic: false,
  });
  // Prefer global display name, then server nickname, then username
  const displayName =
    member.user.globalName ||
    member.displayName ||
    member.nickname ||
    member.user.username;

  return {
    found: true,
    discord_id: member.id,
    discord_username: member.user.username,
    display_name: displayName,
    avatar_url: avatarUrl,
  };
}

// Health check (no secret)
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'bdbs-discord-bot',
    bot_ready: client.isReady(),
    endpoints: ['/lookup-member', '/assign-role'],
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, bot_ready: client.isReady() });
});

// Username / ID দিয়ে Discord profile (Name + Avatar + ID)
app.post('/lookup-member', async (req, res) => {
  if (!checkSecret(req, res)) return;

  const { discord_username, discord_id } = req.body || {};
  if (!discord_username && !discord_id) {
    return res.status(400).json({ error: 'discord_username or discord_id required', found: false });
  }

  try {
    if (!client.isReady()) {
      return res.status(503).json({ error: 'Bot not ready yet', found: false });
    }

    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const member = await findMember(guild, discord_id, discord_username);

    if (!member) {
      console.log('Member not found:', discord_id || discord_username);
      return res.status(404).json({
        error: 'Member not found. User must join the Discord server first, then use exact username.',
        found: false,
      });
    }

    const profile = memberToProfile(member);
    console.log('Lookup OK:', profile.discord_username, profile.display_name, profile.discord_id);
    res.json(profile);
  } catch (err) {
    console.error('lookup-member error:', err);
    res.status(500).json({ error: err.message, found: false });
  }
});

// Role অ্যাসাইন
app.post('/assign-role', async (req, res) => {
  if (!checkSecret(req, res)) return;

  const { discord_id, discord_username, role_id } = req.body || {};
  if (!role_id || (!discord_id && !discord_username)) {
    return res.status(400).json({ error: 'Missing role_id or user identity' });
  }

  try {
    if (!client.isReady()) {
      return res.status(503).json({ error: 'Bot not ready yet' });
    }

    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const member = await findMember(guild, discord_id, discord_username);

    if (!member) {
      console.log('Member not found for role:', discord_id || discord_username);
      return res.status(404).json({
        error: 'Member not found in server. User must join the Discord server first.',
      });
    }

    await member.roles.add(String(role_id));
    console.log(`Role ${role_id} given to ${member.user.tag} (${member.id})`);
    res.json({
      success: true,
      user: member.user.tag,
      discord_id: member.id,
      display_name: member.user.globalName || member.displayName || member.user.username,
    });
  } catch (err) {
    console.error('assign-role error:', err);
    res.status(500).json({ error: err.message });
  }
});

client.once('clientReady', () => {
  console.log(`Bot logged in as ${client.user.tag}`);
});
// fallback for older discord.js
client.once('ready', () => {
  console.log(`Bot logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Webhook server running on port', PORT);
});
