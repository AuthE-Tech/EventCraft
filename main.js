require('dotenv').config();
const { 
    Client, 
    GatewayIntentBits, 
    REST, 
    Routes, 
    SlashCommandBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    EmbedBuilder, 
    PermissionFlagsBits 
} = require('discord.js');
const express = require('express');
const Database = require('better-sqlite3');

// --- ADMIN CONFIGURATION ---
const ADMIN_IDS = ['1442074422419652691', '1397509272828379230'];
const SUPPORT_SERVER = 'https://discord.gg/SNVuexu2F';

// --- DATABASE SETUP ---
const db = new Database('database.sqlite');

db.prepare(`
    CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value INTEGER
    )
`).run();

db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
        discord_id TEXT PRIMARY KEY,
        invites INTEGER DEFAULT 0,
        claimed_invites INTEGER DEFAULT 0
    )
`).run();

db.prepare(`
    CREATE TABLE IF NOT EXISTS smps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL
    )
`).run();

const getRewardPerInvite = () => {
    const row = db.prepare("SELECT value FROM config WHERE key = 'reward_per_invite'").get();
    return row ? row.value : 50000;
};

const setRewardPerInvite = (amount) => {
    db.prepare("INSERT INTO config (key, value) VALUES ('reward_per_invite', ?) ON CONFLICT(key) DO UPDATE SET value = ?")
      .run(amount, amount);
};

const getSMPList = () => {
    return db.prepare("SELECT name FROM smps ORDER BY name ASC").all();
};

// --- DISCORD BOT SETUP ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildInvites
    ]
});

const invitesCache = new Map();

const commands = [
    new SlashCommandBuilder()
        .setName('invpanel')
        .setDescription('Shows the invite panel (Admin Only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('ammount')
        .setDescription('Set the amount per invite (Admin Only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addIntegerOption(option => 
            option.setName('value')
                .setDescription('Amount per invite')
                .setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('smpadd')
        .setDescription('Add a new SMP option to the web portal (Admin Only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(option => 
            option.setName('name')
                .setDescription('Name of the SMP server')
                .setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('smpremove')
        .setDescription('Remove an SMP option from the web portal (Admin Only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(option => 
            option.setName('name')
                .setDescription('Name of the SMP server to remove')
                .setRequired(true)
        )
].map(cmd => cmd.toJSON());

client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands }
        );
        console.log('Slash commands registered.');
    } catch (err) {
        console.error('Error registering commands:', err);
    }

    client.guilds.cache.forEach(async (guild) => {
        try {
            const firstInvites = await guild.invites.fetch();
            invitesCache.set(guild.id, new Map(firstInvites.map((inv) => [inv.code, inv.uses])));
        } catch (err) {
            console.error(`Failed to fetch invites for guild ${guild.id}:`, err);
        }
    });
});

client.on('guildMemberAdd', async (member) => {
    const cachedInvites = invitesCache.get(member.guild.id);
    const newInvites = await member.guild.invites.fetch();
    
    const usedInvite = newInvites.find((inv) => cachedInvites.has(inv.code) && inv.uses > cachedInvites.get(inv.code));
    
    if (usedInvite && usedInvite.inviter) {
        const inviterId = usedInvite.inviter.id;
        db.prepare(`
            INSERT INTO users (discord_id, invites) VALUES (?, 1)
            ON CONFLICT(discord_id) DO UPDATE SET invites = invites + 1
        `).run(inviterId);
    }

    invitesCache.set(member.guild.id, new Map(newInvites.map((inv) => [inv.code, inv.uses])));
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (!ADMIN_IDS.includes(interaction.user.id) && !interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: 'Only admins can use this command.', flags: 64 });
    }

    if (interaction.commandName === 'ammount') {
        const value = interaction.options.getInteger('value');
        setRewardPerInvite(value);
        return interaction.reply({ content: `Reward per invite updated to **$${value.toLocaleString()}**!`, flags: 64 });
    }

    if (interaction.commandName === 'smpadd') {
        const smpName = interaction.options.getString('name');
        try {
            db.prepare("INSERT INTO smps (name) VALUES (?)").run(smpName);
            return interaction.reply({ content: `Added **${smpName}** to the SMP list.`, flags: 64 });
        } catch (e) {
            return interaction.reply({ content: `SMP **${smpName}** already exists or couldn't be added.`, flags: 64 });
        }
    }

    if (interaction.commandName === 'smpremove') {
        const smpName = interaction.options.getString('name');
        const res = db.prepare("DELETE FROM smps WHERE name = ?").run(smpName);
        if (res.changes > 0) {
            return interaction.reply({ content: `Removed **${smpName}** from the SMP list.`, flags: 64 });
        } else {
            return interaction.reply({ content: `SMP **${smpName}** not found in database.`, flags: 64 });
        }
    }

    if (interaction.commandName === 'invpanel') {
        const domain = process.env.REDIRECT_URI ? process.env.REDIRECT_URI.replace('/auth/callback', '') : 'http://localhost:3000';

        const embed = new EmbedBuilder()
            .setTitle('🌐 EventCraft Community Rewards')
            .setDescription(`Earn **$${getRewardPerInvite().toLocaleString()}** in-game currency per invite across all our SMP servers!\n\nVisit our portal to track invites, select your SMP, and withdraw rewards directly.`)
            .setColor(0x3b82f6)
            .setFooter({ text: 'EventCraft Network • Official Portal' });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('Open EventCraft Portal')
                .setStyle(ButtonStyle.Link)
                .setURL(domain),
            new ButtonBuilder()
                .setLabel('Join Discord')
                .setStyle(ButtonStyle.Link)
                .setURL(SUPPORT_SERVER)
        );

        return interaction.reply({ embeds: [embed], components: [row] });
    }
});

// --- EXPRESS WEB SERVER SETUP ---
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const getAuthUrl = () => {
    return `https://discord.com/oauth2/authorize?client_id=${process.env.CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}&response_type=code&scope=identify`;
};

// Base HTML Wrapper Template (Qyro Cloud Inspired Theme)
const renderHTML = (content, pageTitle = "EventCraft") => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${pageTitle}</title>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
        body { 
            background: #050505; 
            color: #f8fafc; 
            min-height: 100vh; 
            display: flex;
            flex-direction: column;
            align-items: center;
        }

        /* Top Modern Pill Nav Header */
        .header-nav-container {
            width: 100%;
            max-width: 1100px;
            padding: 1.5rem 1rem 0 1rem;
            display: flex;
            justify-content: center;
        }
        nav {
            width: 100%;
            background: rgba(18, 18, 22, 0.85);
            backdrop-filter: blur(20px);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 100px;
            padding: 0.75rem 1.5rem;
            display: flex;
            justify-content: space-between;
            align-items: center;
            box-shadow: 0 10px 30px rgba(0,0,0,0.5);
        }
        .logo { font-size: 1.2rem; font-weight: 800; color: #fff; text-decoration: none; display: flex; align-items: center; gap: 10px; }
        .logo-icon { width: 28px; height: 28px; background: #2563eb; border-radius: 50%; display: inline-flex; justify-content: center; align-items: center; font-size: 0.9rem; font-weight: 800; }
        
        .nav-center-links { display: flex; gap: 24px; list-style: none; }
        .nav-center-links a { color: #94a3b8; text-decoration: none; font-size: 0.9rem; font-weight: 500; transition: color 0.2s; }
        .nav-center-links a:hover { color: #fff; }

        .nav-actions { display: flex; gap: 10px; align-items: center; }

        .btn { display: inline-flex; justify-content: center; align-items: center; padding: 9px 18px; border-radius: 100px; border: none; font-size: 0.88rem; font-weight: 600; cursor: pointer; text-decoration: none; transition: all 0.2s; gap: 6px; }
        .btn-primary { background: #2563eb; color: #fff; box-shadow: 0 4px 14px rgba(37, 99, 235, 0.4); }
        .btn-primary:hover { background: #1d4ed8; transform: translateY(-1px); }
        .btn-outline { background: rgba(255, 255, 255, 0.05); color: #fff; border: 1px solid rgba(255, 255, 255, 0.1); }
        .btn-outline:hover { background: rgba(255, 255, 255, 0.12); }
        
        .main-wrapper {
            flex: 1;
            display: flex;
            justify-content: center;
            align-items: center;
            width: 100%;
            padding: 3rem 1rem;
        }

        .container { 
            background: rgba(12, 12, 15, 0.9); 
            border: 1px solid rgba(255, 255, 255, 0.08); 
            padding: 2.5rem; 
            border-radius: 24px; 
            width: 100%; 
            max-width: 480px; 
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7); 
        }

        .hero-title { font-size: 3.2rem; font-weight: 800; line-height: 1.05; letter-spacing: -1.5px; margin-bottom: 1.25rem; color: #fff; }
        .hero-desc { color: #94a3b8; font-size: 1.05rem; line-height: 1.6; margin-bottom: 2rem; max-width: 580px; margin-left: auto; margin-right: auto; }

        .input-group { margin-bottom: 1.25rem; text-align: left; }
        .input-group label { display: block; font-size: 0.85rem; color: #cbd5e1; margin-bottom: 6px; font-weight: 500; }
        input[type="text"], select { width: 100%; padding: 14px; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; color: #fff; font-size: 0.95rem; outline: none; transition: all 0.2s; }
        select option { background: #0f172a; color: #fff; }
        input[type="text"]:focus, select:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.25); }

        .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 1.5rem; }
        .stat-card { background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.05); padding: 1rem; border-radius: 14px; text-align: center; }
        .stat-card .label { font-size: 0.75rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
        .stat-card .value { font-size: 1.25rem; font-weight: 700; color: #f8fafc; }

        .balance-card { background: linear-gradient(135deg, rgba(37, 99, 235, 0.15) 0%, rgba(29, 78, 216, 0.05) 100%); border: 1px solid rgba(37, 99, 235, 0.3); padding: 1.25rem; border-radius: 16px; text-align: center; margin-bottom: 1.5rem; }
        .balance-card .amount { font-size: 2rem; font-weight: 800; color: #60a5fa; margin-top: 4px; }

        .footer-note { text-align: center; padding: 2rem; font-size: 0.8rem; color: #475569; }
        
        @media(max-width: 768px) {
            .nav-center-links { display: none; }
            .hero-title { font-size: 2.2rem; }
        }
    </style>
</head>
<body>
    <div class="header-nav-container">
        <nav>
            <a href="/" class="logo">
                <span class="logo-icon">E</span> EventCraft
            </a>
            
            <ul class="nav-center-links">
                <li><a href="/">Home</a></li>
                <li><a href="${SUPPORT_SERVER}" target="_blank">Support</a></li>
            </ul>

            <div class="nav-actions">
                <a href="${SUPPORT_SERVER}" target="_blank" class="btn btn-outline">
                   Discord
                </a>
                <a href="/login" class="btn btn-outline">Sign In</a>
                <a href="/register" class="btn btn-primary">Sign Up</a>
            </div>
        </nav>
    </div>
    
    <div class="main-wrapper">
        ${content}
    </div>

    <div class="footer-note">
        © EventCraft Network • Verified Reward Ecosystem
    </div>
</body>
</html>
`;

// Homepage (Qyro Cloud Inspired Hero Banner)
app.get('/', (req, res) => {
    res.send(renderHTML(`
        <div style="text-align: center; max-width: 800px;">
            <h1 class="hero-title">Minecraft rewards <br>and invite power on one edge.</h1>
            <p class="hero-desc">
                EventCraft rewards players for growing our SMP communities. Invite friends, track your balance in real-time, and transfer funds directly to your preferred SMP server.
            </p>
            <div style="display: flex; gap: 12px; justify-content: center; align-items: center;">
                <a href="/register" class="btn btn-primary" style="padding: 14px 28px; font-size: 1rem;">Register with Discord</a>
                <a href="/login" class="btn btn-outline" style="padding: 14px 28px; font-size: 1rem;">Sign In</a>
            </div>
        </div>
    `, "EventCraft | Home"));
});

// Auth Entry Points
app.get('/login', (req, res) => res.redirect(getAuthUrl()));
app.get('/register', (req, res) => res.redirect(getAuthUrl()));

// OAuth2 Callback Dashboard Page
app.get('/auth/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.send(renderHTML('<div class="container" style="text-align:center;"><p>Authorization code missing.</p></div>'));

    try {
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: process.env.CLIENT_ID,
                client_secret: process.env.CLIENT_SECRET,
                grant_type: 'authorization_code',
                code,
                redirect_uri: process.env.REDIRECT_URI,
            }),
        });

        const tokenData = await tokenResponse.json();
        if (!tokenData.access_token) return res.send(renderHTML('<div class="container" style="text-align:center;"><p>Authentication failed. Please try again.</p></div>'));

        const userResponse = await fetch('https://discord.com/api/users/@me', {
            headers: { authorization: `${tokenData.token_type} ${tokenData.access_token}` },
        });
        const userData = await userResponse.json();

        const avatarUrl = userData.avatar 
            ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png` 
            : `https://cdn.discordapp.com/embed/avatars/${userData.discriminator % 5}.png`;

        let userRow = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(userData.id);
        if (!userRow) {
            db.prepare('INSERT INTO users (discord_id, invites, claimed_invites) VALUES (?, 0, 0)').run(userData.id);
            userRow = { discord_id: userData.id, invites: 0, claimed_invites: 0 };
        }

        const availableInvites = userRow.invites - userRow.claimed_invites;
        const rewardPerInvite = getRewardPerInvite();
        const pendingAmount = availableInvites * rewardPerInvite;
        const smpList = getSMPList();

        let smpOptionsHTML = '';
        if (smpList.length === 0) {
            smpOptionsHTML = '<option value="Default SMP">Default SMP</option>';
        } else {
            smpList.forEach(smp => {
                smpOptionsHTML += `<option value="${smp.name}">${smp.name}</option>`;
            });
        }

        res.send(renderHTML(`
            <div class="container">
                <div style="display: flex; align-items: center; gap: 14px; margin-bottom: 2rem;">
                    <img src="${avatarUrl}" style="width: 52px; height: 52px; border-radius: 50%; border: 2px solid #2563eb;" alt="Profile">
                    <div style="text-align: left;">
                        <h2 style="font-size: 1.25rem; font-weight: 700; color: #fff;">${userData.global_name || userData.username}</h2>
                        <span style="font-size: 0.8rem; color: #4ade80; background: rgba(34, 197, 94, 0.15); padding: 2px 8px; border-radius: 12px; font-weight: 600;">Authenticated User</span>
                    </div>
                </div>

                <div class="stats-grid">
                    <div class="stat-card">
                        <div class="label">Total Invites</div>
                        <div class="value">${userRow.invites}</div>
                    </div>
                    <div class="stat-card">
                        <div class="label">Unclaimed</div>
                        <div class="value">${availableInvites}</div>
                    </div>
                </div>

                <div class="balance-card">
                    <div class="label">Available Currency</div>
                    <div class="amount">$${pendingAmount.toLocaleString()}</div>
                </div>

                ${availableInvites > 0 ? `
                    <form action="/withdraw" method="POST">
                        <input type="hidden" name="discord_id" value="${userData.id}" />
                        
                        <div class="input-group">
                            <label for="smp_server">Select SMP Server</label>
                            <select id="smp_server" name="smp_server" required>
                                ${smpOptionsHTML}
                            </select>
                        </div>

                        <div class="input-group">
                            <label for="ign">In-Game Name (IGN)</label>
                            <input type="text" id="ign" name="ign" placeholder="Enter In-Game Name" required autocomplete="off" />
                        </div>

                        <button type="submit" class="btn btn-primary" style="width: 100%; padding: 14px; border-radius: 12px;">Confirm & Cash Out</button>
                    </form>
                ` : `
                    <button class="btn btn-outline" style="width: 100%; opacity: 0.5; cursor: not-allowed;" disabled>No Invites Available to Cash Out</button>
                `}
            </div>
        `, "EventCraft | Dashboard"));
    } catch (err) {
        console.error(err);
        res.send(renderHTML('<div class="container" style="text-align:center;"><p>An unexpected system error occurred.</p></div>'));
    }
});

// Withdrawal Processing Page
app.post('/withdraw', async (req, res) => {
    const { discord_id, ign, smp_server } = req.body;

    const userRow = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discord_id);
    if (!userRow) return res.send(renderHTML('<div class="container" style="text-align:center;"><p>User record missing.</p></div>'));

    const availableInvites = userRow.invites - userRow.claimed_invites;
    if (availableInvites <= 0) return res.send(renderHTML('<div class="container" style="text-align:center;"><p>No valid balance to cash out.</p></div>'));

    const rewardPerInvite = getRewardPerInvite();
    const totalAmount = availableInvites * rewardPerInvite;

    db.prepare('UPDATE users SET claimed_invites = invites WHERE discord_id = ?').run(discord_id);

    // Exact requested format for DM notification
    const notificationMessage = `${ign} are waiting to withdraw ${totalAmount.toLocaleString()} send them quickly. (SMP: ${smp_server})`;

    for (const adminId of ADMIN_IDS) {
        try {
            const adminUser = await client.users.fetch(adminId);
            if (adminUser) {
                await adminUser.send(notificationMessage);
            }
        } catch (err) {
            console.error(`Could not send DM to admin ${adminId}:`, err);
        }
    }

    res.send(renderHTML(`
        <div class="container" style="text-align: center;">
            <div style="width: 64px; height: 64px; background: rgba(34, 197, 94, 0.15); border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 1.5rem auto; color: #4ade80; font-size: 2rem;">✓</div>
            <h2 style="font-size: 1.5rem; margin-bottom: 8px;">Withdrawal Submitted!</h2>
            <p style="color: #94a3b8; font-size: 0.95rem; line-height: 1.5; margin-bottom: 1.5rem;">
                Your request of <b style="color: #60a5fa;">$${totalAmount.toLocaleString()}</b> for <b>${ign}</b> on <b>${smp_server}</b> is now processing.
            </p>
            <div style="background: rgba(255,255,255,0.03); padding: 1rem; border-radius: 12px; font-size: 0.85rem; color: #cbd5e1; border: 1px solid rgba(255,255,255,0.05);">
                ⌛ Status: <b>Amount will be added in some hours.</b>
            </div>
        </div>
    `, "EventCraft | Confirmation"));
});

// Start Servers
client.login(process.env.DISCORD_TOKEN);
app.listen(process.env.PORT || 3000, () => {
    console.log(`EventCraft web portal running on port ${process.env.PORT || 3000}`);
});
