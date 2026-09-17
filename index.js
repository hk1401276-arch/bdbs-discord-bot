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

app.post('/assign-role', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { discord_id, discord_username, role_id } = req.body;
  if (!role_id || (!discord_id && !discord_username)) {
    return res.status(400).json({ error: 'Missing role_id or user identity' });
  }

  try {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    let member = null;

    if (discord_id) {
      try {
        member = await guild.members.fetch(discord_id);
      } catch (e) {
        console.log('Could not fetch by ID:', discord_id);
      }
    }

    if (!member && discord_username) {
      await guild.members.fetch();
      const uname = discord_username.toLowerCase().replace(/^@/, '');
      member = guild.members.cache.find(
        (m) =>
          m.user.username.toLowerCase() === uname ||
          (m.user.globalName && m.user.globalName.toLowerCase() === uname) ||
          (m.displayName && m.displayName.toLowerCase() === uname)
      );
    }

    if (!member) {
      console.log('Member not found:', discord_id || discord_username);
      return res.status(404).json({
        error: 'Member not found in server. User must join the Discord server first.'
      });
    }

    await member.roles.add(role_id);
    console.log(`Role ${role_id} given to ${member.user.tag} (${member.id})`);
    res.json({ success: true, user: member.user.tag });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

client.once('clientReady', () => {
  console.log(`Bot logged in as ${client.user.tag}`);
});

client.once('ready', () => {
  console.log(`Bot logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Webhook server running on port', PORT);
});