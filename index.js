require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const mysql = require('mysql2/promise');
const express = require('express');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.GuildMember],
});

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
});

const app = express();
app.use(express.json());

// Website থেকে Role অ্যাসাইন করার API
app.post('/assign-role', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { discord_id, role_id } = req.body;
  if (!discord_id || !role_id) {
    return res.status(400).json({ error: 'Missing data' });
  }

  try {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const member = await guild.members.fetch(discord_id);
    await member.roles.add(role_id);
    console.log(`Role ${role_id} given to ${discord_id}`);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

client.once('ready', () => {
  console.log(`Bot logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);

app.listen(process.env.PORT || 3000, () => {
  console.log('Webhook server running');
});