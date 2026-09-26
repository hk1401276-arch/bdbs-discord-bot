require('dotenv').config();
const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');
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

// ========== AUTO PROFILE SYNC (name / avatar change) ==========
// Store-এর api_discord_profile_update.php URL এখানে দাও (অথবা Railway env-এ STORE_PROFILE_SYNC_URL সেট কর)
const STORE_SYNC_URL = process.env.STORE_PROFILE_SYNC_URL || 'https://store.bdbussim.com/api_discord_profile_update.php';
const STORE_SYNC_SECRET = process.env.WEBHOOK_SECRET;

async function pushProfileToStore(member) {
  try {
    const profile = memberToProfile(member);
    const res = await fetch(STORE_SYNC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': STORE_SYNC_SECRET,
      },
      body: JSON.stringify({
        discord_id: profile.discord_id,
        discord_username: profile.discord_username,
        display_name: profile.display_name,
        avatar_url: profile.avatar_url,
      }),
    });
    const data = await res.json().catch(() => ({}));
    console.log('Profile sync result:', profile.discord_id, data);
  } catch (e) {
    console.error('pushProfileToStore error:', e.message);
  }
}

// Username / globalName / avatar change
client.on('userUpdate', async (oldUser, newUser) => {
  if (
    oldUser.username === newUser.username &&
    oldUser.globalName === newUser.globalName &&
    oldUser.avatar === newUser.avatar
  ) return;

  try {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const member = await guild.members.fetch(newUser.id).catch(() => null);
    if (!member) return;
    console.log('userUpdate detected:', newUser.username, newUser.id);
    await pushProfileToStore(member);
  } catch (e) {
    console.error('userUpdate handler error:', e.message);
  }
});

// Server nickname change
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  if (
    oldMember.nickname === newMember.nickname &&
    oldMember.user.username === newMember.user.username &&
    oldMember.user.avatar === newMember.user.avatar
  ) return;

  console.log('guildMemberUpdate detected:', newMember.user.username, newMember.id);
  await pushProfileToStore(newMember);
});

// Health check (no secret)
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'bdbs-discord-bot',
    bot_ready: client.isReady(),
    endpoints: ['/lookup-member', '/assign-role', '/announce', '/dm-user'],
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

// Discord channel auto-announce (embed)
app.post('/announce', async (req, res) => {
  if (!checkSecret(req, res)) return;

  const body = req.body || {};
  const channelId = String(body.channel_id || process.env.ANNOUNCE_CHANNEL_ID || '').trim();
  if (!channelId) {
    return res.status(400).json({ error: 'channel_id required (body or ANNOUNCE_CHANNEL_ID env)' });
  }

  const title = String(body.title || 'Announcement').slice(0, 256);
  const description = String(body.description || '').slice(0, 4000);
  const color = Number(body.color) || 0x6366f1;
  const imageUrl = body.image_url ? String(body.image_url) : null;
  const thumbnailUrl = body.thumbnail_url ? String(body.thumbnail_url) : null;
  const url = body.url ? String(body.url) : null;
  const footer = body.footer ? String(body.footer).slice(0, 2048) : 'BD BUS SIM Asset Store';
  const fields = Array.isArray(body.fields) ? body.fields.slice(0, 25) : [];
  const content = body.content ? String(body.content).slice(0, 2000) : null; // @everyone optional

  try {
    if (!client.isReady()) {
      return res.status(503).json({ error: 'Bot not ready yet' });
    }

    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      return res.status(400).json({ error: 'Invalid channel or not text-based' });
    }

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setColor(color)
      .setTimestamp()
      .setFooter({ text: footer });

    if (description) embed.setDescription(description);
    if (url) embed.setURL(url);
    if (imageUrl && /^https?:\/\//i.test(imageUrl)) embed.setImage(imageUrl);
    if (thumbnailUrl && /^https?:\/\//i.test(thumbnailUrl)) embed.setThumbnail(thumbnailUrl);

    for (const f of fields) {
      if (!f || !f.name) continue;
      embed.addFields({
        name: String(f.name).slice(0, 256),
        value: String(f.value || '—').slice(0, 1024),
        inline: !!f.inline,
      });
    }

    const payload = { embeds: [embed] };
    if (content) payload.content = content;

    await channel.send(payload);
    console.log('Announce sent to channel', channelId);
    res.json({ success: true, channel_id: channelId });
  } catch (err) {
    console.error('announce error:', err);
    res.status(500).json({ error: err.message, success: false });
  }
});

// DM to a specific user
app.post('/dm-user', async (req, res) => {
  if (!checkSecret(req, res)) return;

  const body = req.body || {};
  const { discord_id, discord_username } = body;
  if (!discord_id && !discord_username) {
    return res.status(400).json({ error: 'discord_id or discord_username required' });
  }

  const title = String(body.title || 'Notification').slice(0, 256);
  const description = String(body.description || '').slice(0, 4000);
  const color = Number(body.color) || 0x22c55e;
  const footer = body.footer ? String(body.footer).slice(0, 2048) : 'BD BUS SIM Asset Store';
  const fields = Array.isArray(body.fields) ? body.fields.slice(0, 25) : [];
  const content = body.content ? String(body.content).slice(0, 2000) : null;
  const imageUrl = body.image_url ? String(body.image_url) : null;
  const url = body.url ? String(body.url) : null;

  try {
    if (!client.isReady()) {
      return res.status(503).json({ error: 'Bot not ready yet' });
    }

    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const member = await findMember(guild, discord_id, discord_username);
    if (!member) {
      return res.status(404).json({
        error: 'Member not found in server. User must join Discord first.',
        success: false,
      });
    }

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setColor(color)
      .setTimestamp()
      .setFooter({ text: footer });

    if (description) embed.setDescription(description);
    if (url) embed.setURL(url);
    if (imageUrl && /^https?:\/\//i.test(imageUrl)) embed.setImage(imageUrl);

    for (const f of fields) {
      if (!f || !f.name) continue;
      embed.addFields({
        name: String(f.name).slice(0, 256),
        value: String(f.value || '—').slice(0, 1024),
        inline: !!f.inline,
      });
    }

    const payload = { embeds: [embed] };
    if (content) payload.content = content;

    await member.send(payload);
    console.log('DM sent to', member.user.tag, member.id);
    res.json({ success: true, discord_id: member.id });
  } catch (err) {
    console.error('dm-user error:', err);
    // Often: Cannot send messages to this user (DMs closed)
    res.status(500).json({ error: err.message, success: false });
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