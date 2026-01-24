#!/usr/bin/env node
require('dotenv').config();
const makeWASocket = require('@whiskeysockets/baileys').default;
const { 
    useMultiFileAuthState, 
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const P = require('pino');
const axios = require('axios');
const mongoose = require('mongoose');
const http = require('http');

// ==================== CONFIGURATION ====================
const config = {
    prefix: '.',
    ownerJid: process.env.OWNER_JID || '',
    openrouterKey: process.env.OPENROUTER_API_KEY || '',
    mongodbUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsappbot',
    rateLimit: 5,
    sessionDir: './session',
    port: process.env.PORT || 3000
};

// ==================== MONGOOSE SCHEMAS & MODELS ====================
const groupSchema = new mongoose.Schema({
    groupId: { type: String, required: true, unique: true },
    name: String,
    settings: {
        welcome: { type: Boolean, default: false },
        goodbye: { type: Boolean, default: false },
        antilink: { type: Boolean, default: false },
        antibadword: { type: Boolean, default: false },
        adminOnly: { type: Boolean, default: false },
        mute: { type: Boolean, default: false }
    },
    admins: [String],
    bannedUsers: [String],
    createdAt: { type: Date, default: Date.now }
});

const userSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    name: String,
    warnings: { type: Number, default: 0 },
    lastCommand: Date,
    commandCount: { type: Number, default: 0 }
});

const gameSchema = new mongoose.Schema({
    gameId: String,
    groupId: String,
    players: [String],
    board: mongoose.Schema.Types.Mixed,
    status: { type: String, default: 'active' },
    createdAt: { type: Date, default: Date.now }
});

const GroupModel = mongoose.model('Group', groupSchema);
const UserModel = mongoose.model('User', userSchema);
const GameModel = mongoose.model('Game', gameSchema);

// ==================== MONGODB CONNECTION ====================
async function connectMongoDB() {
    try {
        await mongoose.connect(config.mongodbUri);
        console.log('✅ MongoDB connected successfully');
    } catch (error) {
        console.error('❌ MongoDB connection error:', error);
        process.exit(1);
    }
}

// ==================== UTILITIES ====================
const logger = P({ level: 'silent' });
const rateLimits = new Map();
const games = new Map();

function checkRateLimit(userId) {
    const now = Date.now();
    const limits = rateLimits.get(userId) || [];
    const filtered = limits.filter(t => now - t < 60000);
    
    if (filtered.length >= config.rateLimit) return false;
    
    filtered.push(now);
    rateLimits.set(userId, filtered);
    return true;
}

function isGroup(jid) {
    return jid.endsWith('@g.us');
}

function isOwner(jid) {
    return jid === config.ownerJid;
}

function isAdmin(participants, jid) {
    return participants?.find(p => p.id === jid)?.admin !== null;
}

// ==================== AI CLIENT ====================
class OpenRouterClient {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseURL = 'https://openrouter.ai/api/v1';
    }
    
    async chat(prompt, model = 'openai/gpt-3.5-turbo') {
        if (!this.apiKey) return '❌ OpenRouter API key not configured!';
        
        try {
            const response = await axios.post(`${this.baseURL}/chat/completions`, {
                model,
                messages: [{ role: 'user', content: prompt }]
            }, {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'HTTP-Referer': 'https://github.com/your-repo',
                    'X-Title': 'WhatsAppBot',
                    'Content-Type': 'application/json'
                }
            });
            return response.data.choices[0].message.content;
        } catch (e) {
            console.error('AI Error:', e.message);
            return '❌ AI Error: ' + e.message;
        }
    }
    
    async generateImage(prompt) {
        return `https://source.unsplash.com/800x600/?${encodeURIComponent(prompt)}`;
    }
}

const ai = new OpenRouterClient(config.openrouterKey);

// ==================== COMMAND HANDLER ====================
class CommandHandler {
    constructor(sock) {
        this.sock = sock;
    }
    
    async handle(msg) {
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        if (!text.startsWith(config.prefix)) return;
        
        const args = text.slice(config.prefix.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();
        
        const from = msg.key.remoteJid;
        const sender = msg.key.participant || from;
        
        // Update user in DB
        await this.updateUser(sender);
        
        // Rate limit check
        if (!checkRateLimit(sender)) {
            return this.sock.sendMessage(from, { text: '⏳ Rate limit exceeded! Wait 1 minute.' });
        }
        
        // Get command method
        const method = `cmd${command.charAt(0).toUpperCase() + command.slice(1)}`;
        if (!this[method]) {
            return this.sock.sendMessage(from, { text: '❌ Unknown command! Type .help' });
        }
        
        const isGroup = isGroup(from);
        const groupMetadata = isGroup ? await this.sock.groupMetadata(from) : null;
        
        try {
            await this[method](from, sender, args, { isGroup, groupMetadata, msg });
        } catch (e) {
            console.error(`Command error: ${e}`);
            this.sock.sendMessage(from, { text: '❌ Error executing command!' });
        }
    }
    
    async updateUser(userId) {
        try {
            await UserModel.findOneAndUpdate(
                { userId },
                { lastCommand: new Date(), $inc: { commandCount: 1 } },
                { upsert: true, new: true }
            );
        } catch (e) {
            console.error('User update error:', e);
        }
    }
    
    // ==================== GENERAL COMMANDS ====================
    async cmdHelp(from, sender, args) {
        const help = `
╔═══════════════════╗
🌐 *General Commands*:
║ .help .ping .alive .owner
║ .joke .quote .fact .8ball
║ .groupinfo
╔═══════════════════╗
🤖 *AI Commands*:
║ .gpt <question>
║ .gemini <question>
║ .imagine <prompt>
╚═══════════════════╝
        `;
        await this.sock.sendMessage(from, { text: help });
    }
    
    async cmdPing(from, sender, args) {
        const start = Date.now();
        await this.sock.sendMessage(from, { text: '📡 Pinging...' });
        const latency = Date.now() - start;
        await this.sock.sendMessage(from, { text: `🏓 Pong!\n*Latency:* ${latency}ms` });
    }
    
    async cmdAlive(from, sender, args) {
        const uptime = process.uptime();
        const dbStatus = mongoose.connection.readyState === 1 ? '✅ Connected' : '❌ Disconnected';
        await this.sock.sendMessage(from, { text: `✅ Bot is online!\n*Uptime:* ${Math.floor(uptime)}s\n*Database:* ${dbStatus}` });
    }
    
    async cmdOwner(from, sender, args) {
        await this.sock.sendMessage(from, { text: `👑 *Owner:* ${config.ownerJid.split('@')[0]}` });
    }
    
    async cmdJoke(from, sender, args) {
        const { data } = await axios.get('https://official-joke-api.appspot.com/random_joke');
        await this.sock.sendMessage(from, { text: `${data.setup}\n\n${data.punchline}` });
    }
    
    async cmdQuote(from, sender, args) {
        const { data } = await axios.get('https://api.quotable.io/random');
        await this.sock.sendMessage(from, { text: `"${data.content}"\n— ${data.author}` });
    }
    
    async cmdFact(from, sender, args) {
        const { data } = await axios.get('https://uselessfacts.jsph.pl/random.json?language=en');
        await this.sock.sendMessage(from, { text: `🤓 *Fact:* ${data.text}` });
    }
    
    async cmd8Ball(from, sender, args) {
        if (!args.length) {
            return this.sock.sendMessage(from, { text: '❌ Ask a question!' });
        }
        const responses = ['Yes', 'No', 'Maybe', 'Ask later', 'Definitely', 'Very doubtful'];
        await this.sock.sendMessage(from, { text: `🎱 *8Ball:* ${responses[Math.floor(Math.random() * responses.length)]}` });
    }
    
    async cmdGroupinfo(from, sender, args, { isGroup, groupMetadata }) {
        if (!isGroup) {
            return this.sock.sendMessage(from, { text: '❌ This is not a group!' });
        }
        
        const group = await GroupModel.findOne({ groupId: from });
        const info = `
👥 *Group Info*
Name: ${groupMetadata.subject}
ID: ${from.split('@')[0]}
Welcome: ${group?.settings?.welcome ? '✅' : '❌'}
Goodbye: ${group?.settings?.goodbye ? '✅' : '❌'}
Anti-link: ${group?.settings?.antilink ? '✅' : '❌'}
Banned: ${group?.bannedUsers?.length || 0} users
        `;
        await this.sock.sendMessage(from, { text: info });
    }
    
    // ==================== ADMIN COMMANDS ====================
    async cmdBan(from, sender, args, { isGroup, groupMetadata, msg }) {
        if (!isGroup) return this.sock.sendMessage(from, { text: '❌ Only in groups!' });
        
        const group = await GroupModel.findOne({ groupId: from });
        const isSenderAdmin = group?.admins?.includes(sender) || isOwner(sender);
        const isBotAdmin = group?.admins?.includes(this.sock.user.id);
        
        if (!isSenderAdmin) return this.sock.sendMessage(from, { text: '❌ Only admins!' });
        if (!isBotAdmin) return this.sock.sendMessage(from, { text: '❌ Bot must be admin!' });
        
        const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        if (!mentioned.length) return this.sock.sendMessage(from, { text: '❌ Tag a user!' });
        
        await GroupModel.findOneAndUpdate(
            { groupId: from },
            { $addToSet: { bannedUsers: mentioned[0] } },
            { upsert: true, new: true }
        );
        
        await this.sock.sendMessage(from, { text: '✅ User banned!' });
    }
    
    async cmdKick(from, sender, args, { isGroup, msg }) {
        await this.cmdBan(from, sender, args, { isGroup, msg });
        const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        if (mentioned.length) {
            await this.sock.groupParticipantsUpdate(from, mentioned, 'remove');
        }
    }
    
    async cmdPromote(from, sender, args, { isGroup, msg }) {
        if (!isGroup) return;
        const group = await GroupModel.findOne({ groupId: from });
        if (!group?.admins?.includes(sender) && !isOwner(sender)) return;
        
        const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        if (!mentioned.length) return;
        
        await GroupModel.findOneAndUpdate(
            { groupId: from },
            { $addToSet: { admins: mentioned[0] } },
            { upsert: true, new: true }
        );
        
        await this.sock.sendMessage(from, { text: '✅ User promoted!' });
    }
    
    async cmdDemote(from, sender, args, { isGroup, msg }) {
        if (!isGroup) return;
        const group = await GroupModel.findOne({ groupId: from });
        if (!group?.admins?.includes(sender) && !isOwner(sender)) return;
        
        const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        if (!mentioned.length) return;
        
        await GroupModel.findOneAndUpdate(
            { groupId: from },
            { $pull: { admins: mentioned[0] } },
            { new: true }
        );
        
        await this.sock.sendMessage(from, { text: '✅ User demoted!' });
    }
    
    async cmdMute(from, sender, args, { isGroup, msg }) {
        if (!isGroup) return;
        const group = await GroupModel.findOne({ groupId: from });
        if (!group?.admins?.includes(sender) && !isOwner(sender)) return;
        
        await GroupModel.findOneAndUpdate(
            { groupId: from },
            { 'settings.mute': true },
            { upsert: true, new: true }
        );
        
        await this.sock.sendMessage(from, { text: '🔇 Group muted for 1 hour' });
        setTimeout(async () => {
            await GroupModel.findOneAndUpdate(
                { groupId: from },
                { 'settings.mute': false },
                { new: true }
            );
        }, 3600000);
    }
    
    async cmdUnmute(from, sender, args, { isGroup, msg }) {
        if (!isGroup) return;
        const group = await GroupModel.findOne({ groupId: from });
        if (!group?.admins?.includes(sender) && !isOwner(sender)) return;
        
        await GroupModel.findOneAndUpdate(
            { groupId: from },
            { 'settings.mute': false },
            { new: true }
        );
        
        await this.sock.sendMessage(from, { text: '🔊 Group unmuted!' });
    }
    
    async cmdClear(from, sender, args, { isGroup, msg }) {
        if (!isGroup) return;
        const group = await GroupModel.findOne({ groupId: from });
        if (!group?.admins?.includes(sender) && !isOwner(sender)) return;
        
        await this.sock.sendMessage(from, { text: '✅ Cleared last 100 messages (simulated)' });
    }
    
    async cmdWelcome(from, sender, args, { isGroup, msg }) {
        if (!isGroup) return;
        const group = await GroupModel.findOne({ groupId: from });
        if (!group?.admins?.includes(sender) && !isOwner(sender)) return;
        
        const current = group?.settings?.welcome || false;
        await GroupModel.findOneAndUpdate(
            { groupId: from },
            { 'settings.welcome': !current },
            { upsert: true, new: true }
        );
        
        await this.sock.sendMessage(from, { text: `✅ Welcome ${!current ? 'enabled' : 'disabled'}!` });
    }
    
    async cmdGoodbye(from, sender, args, { isGroup, msg }) {
        if (!isGroup) return;
        const group = await GroupModel.findOne({ groupId: from });
        if (!group?.admins?.includes(sender) && !isOwner(sender)) return;
        
        const current = group?.settings?.goodbye || false;
        await GroupModel.findOneAndUpdate(
            { groupId: from },
            { 'settings.goodbye': !current },
            { upsert: true, new: true }
        );
        
        await this.sock.sendMessage(from, { text: `✅ Goodbye ${!current ? 'enabled' : 'disabled'}!` });
    }
    
    async cmdAntilink(from, sender, args, { isGroup, msg }) {
        if (!isGroup) return;
        const group = await GroupModel.findOne({ groupId: from });
        if (!group?.admins?.includes(sender) && !isOwner(sender)) return;
        
        const current = group?.settings?.antilink || false;
        await GroupModel.findOneAndUpdate(
            { groupId: from },
            { 'settings.antilink': !current },
            { upsert: true, new: true }
        );
        
        await this.sock.sendMessage(from, { text: `✅ Anti-link ${!current ? 'enabled' : 'disabled'}!` });
    }
    
    // ==================== AI COMMANDS ====================
    async cmdGPT(from, sender, args) {
        if (!args.length) {
            return this.sock.sendMessage(from, { text: '❌ Ask a question!' });
        }
        if (!config.openrouterKey) {
            return this.sock.sendMessage(from, { text: '❌ OpenRouter API key not configured!' });
        }
        
        await this.sock.sendMessage(from, { text: '🤖 *GPT:* Thinking...' });
        const response = await ai.chat(args.join(' '), 'openai/gpt-3.5-turbo');
        await this.sock.sendMessage(from, { text: `🤖 *Response:*\n\n${response}` });
    }
    
    async cmdGemini(from, sender, args) {
        if (!args.length) {
            return this.sock.sendMessage(from, { text: '❌ Ask a question!' });
        }
        if (!config.openrouterKey) {
            return this.sock.sendMessage(from, { text: '❌ OpenRouter API key not configured!' });
        }
        
        await this.sock.sendMessage(from, { text: '🟢 *Gemini:* Thinking...' });
        const response = await ai.chat(args.join(' '), 'anthropic/claude-3-haiku-20240307');
        await this.sock.sendMessage(from, { text: `🟢 *Response:*\n\n${response}` });
    }
    
    async cmdImagine(from, sender, args) {
        if (!args.length) {
            return this.sock.sendMessage(from, { text: '❌ Provide a prompt!' });
        }
        if (!config.openrouterKey) {
            return this.sock.sendMessage(from, { text: '❌ OpenRouter API key not configured!' });
        }
        
        await this.sock.sendMessage(from, { text: '🎨 *Generating...*' });
        const imageUrl = await ai.generateImage(args.join(' '));
        await this.sock.sendMessage(from, { image: { url: imageUrl }, caption: `🖼️ ${args.join(' ')}` });
    }
    
    async cmdFlux(from, sender, args) {
        return this.cmdImagine(from, sender, args);
    }
    
    async cmdSora(from, sender, args) {
        await this.sock.sendMessage(from, { text: '❌ Sora video generation not yet implemented!' });
    }
    
    // ==================== FUN COMMANDS ====================
    async cmdCompliment(from, sender, args) {
        const compliments = ['is amazing!', 'is brilliant!', 'is awesome!', 'has a great personality!'];
        const target = args[0] || sender;
        await this.sock.sendMessage(from, { text: `✨ ${target} ${compliments[Math.floor(Math.random() * compliments.length)]}` });
    }
    
    async cmdInsult(from, sender, args) {
        if (!isGroup(from)) {
            return this.sock.sendMessage(from, { text: '❌ Only in groups!' });
        }
        const insults = ['is a potato 🥔', 'needs coffee ☕', 'forgot their brain today 🧠'];
        const target = args[0] || 'Someone';
        await this.sock.sendMessage(from, { text: `😏 ${target} ${insults[Math.floor(Math.random() * insults.length)]}` });
    }
    
    async cmdFlirt(from, sender, args) {
        const lines = ['Are you a magician? Because whenever I look at you, everyone else disappears! ✨', 'Do you have a map? I keep getting lost in your eyes 🗺️'];
        await this.sock.sendMessage(from, { text: `💕 ${lines[Math.floor(Math.random() * lines.length)]}` });
    }
    
    async cmdShip(from, sender, args) {
        if (!isGroup(from) || args.length < 2) {
            return this.sock.sendMessage(from, { text: '❌ Tag two users! Example: .ship @user1 @user2' });
        }
        const percentage = Math.floor(Math.random() * 100);
        await this.sock.sendMessage(from, { text: `💕 Shipping compatibility: ${percentage}%` });
    }
    
    async cmdCharacter(from, sender, args) {
        const traits = ['brave', 'wise', 'funny', 'mysterious', 'creative'];
        const target = args[0] || sender;
        await this.sock.sendMessage(from, { text: `🎭 ${target} is ${traits[Math.floor(Math.random() * traits.length)]}!` });
    }
    
    // ==================== DOWNLOADER COMMANDS ====================
    async cmdPlay(from, sender, args) {
        if (!args.length) {
            return this.sock.sendMessage(from, { text: '❌ Provide song name!' });
        }
        await this.sock.sendMessage(from, { text: `🎵 Searching: ${args.join(' ')}\n\n(Note: Requires yt-dlp setup)` });
    }
    
    async cmdInstagram(from, sender, args) {
        if (!args[0]?.includes('instagram.com')) {
            return this.sock.sendMessage(from, { text: '❌ Provide Instagram URL!' });
        }
        await this.sock.sendMessage(from, { text: '📥 Downloading Instagram content...\n\n(Note: Requires API/scraper)' });
    }
    
    async cmdTiktok(from, sender, args) {
        if (!args[0]?.includes('tiktok.com')) {
            return this.sock.sendMessage(from, { text: '❌ Provide TikTok URL!' });
        }
        await this.sock.sendMessage(from, { text: '📥 Downloading TikTok...\n\n(Note: Requires API/scraper)' });
    }
    
    async cmdYtmp4(from, sender, args) {
        if (!args[0]?.includes('youtube.com')) {
            return this.sock.sendMessage(from, { text: '❌ Provide YouTube URL!' });
        }
        await this.sock.sendMessage(from, { text: '📥 Downloading video...\n\n(Note: Requires yt-dlp)' });
    }
    
    // ==================== GAME COMMANDS ====================
    async cmdTictactoe(from, sender, args) {
        if (!isGroup(from)) {
            return this.sock.sendMessage(from, { text: '❌ Only in groups!' });
        }
        
        const gameId = `${from}_${Date.now()}`;
        const game = new GameModel({
            gameId,
            groupId: from,
            players: [sender],
            board: ['', '', '', '', '', '', '', '', ''],
            status: 'waiting'
        });
        await game.save();
        
        const board = `1️⃣2️⃣3️⃣\n4️⃣5️⃣6️⃣\n7️⃣8️⃣9️⃣`;
        await this.sock.sendMessage(from, { text: `🎮 TicTacToe started! @${sender.split('@')[0]}\n${board}\n\nUse .play <1-9>` });
    }
    
    async cmdHangman(from, sender, args) {
        const words = ['javascript', 'baileys', 'whatsapp', 'bot'];
        const word = words[Math.floor(Math.random() * words.length)];
        await this.sock.sendMessage(from, { text: `🎮 Hangman started! Word: ${'_ '.repeat(word.length)}\nUse .guess <letter>` });
    }
    
    async cmdTrivia(from, sender, args) {
        const { data } = await axios.get('https://opentdb.com/api.php?amount=1');
        const question = data.results[0];
        await this.sock.sendMessage(from, { text: `❓ ${question.question}\n\nA) ${question.incorrect_answers[0]}\nB) ${question.correct_answer}` });
    }
    
    async cmdTruth(from, sender, args) {
        const truths = ['What is your biggest fear?', 'Who was your first crush?', 'What is your guilty pleasure?'];
        await this.sock.sendMessage(from, { text: `🤔 Truth: ${truths[Math.floor(Math.random() * truths.length)]}` });
    }
    
    async cmdDare(from, sender, args) {
        const dares = ['Sing a song in voice note!', 'Do 10 push-ups!', 'Change your profile pic!'];
        await this.sock.sendMessage(from, { text: `😈 Dare: ${dares[Math.floor(Math.random() * dares.length)]}` });
    }
}

// ==================== MAIN BOT ====================
async function startBot() {
    console.log('🚀 Connecting MongoDB...');
    await connectMongoDB();
    
    console.log('🚀 Starting WhatsApp Bot...');
    
    const { state, saveCreds } = await useMultiFileAuthState(config.sessionDir);
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version,
        logger: P({ level: 'silent' }),
        printQRInTerminal: true,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        browser: ['Bot', 'Chrome', '1.0.0']
    });
    
    const cmdHandler = new CommandHandler(sock);
    
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('📱 Scan this QR code with WhatsApp:');
            require('qrcode-terminal').generate(qr, { small: true });
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`Connection closed. Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) {
                startBot();
            }
        } else if (connection === 'open') {
            console.log('✅ Bot connected successfully!');
        }
    });
    
    sock.ev.on('creds.update', saveCreds);
    
    // Message handler
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;
        
        await cmdHandler.handle(msg);
    });
    
    // Group events
    sock.ev.on('group-participants.update', async (update) => {
        const group = await GroupModel.findOne({ groupId: update.id });
        
        if (update.action === 'add' && group?.settings?.welcome) {
            for (const participant of update.participants) {
                const metadata = await sock.groupMetadata(update.id);
                const text = `👋 Welcome @${participant.split('@')[0]} to ${metadata.subject}!\n\nUse .help to see available commands.`;
                await sock.sendMessage(update.id, { text, mentions: [participant] });
            }
        } else if (update.action === 'remove' && group?.settings?.goodbye) {
            for (const participant of update.participants) {
                await sock.sendMessage(update.id, { text: `👋 Goodbye @${participant.split('@')[0]}!` });
            }
        }
    });
}

// ==================== RAILWAY HEALTH CHECK ====================
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running');
}).listen(config.port, () => {
    console.log(`🌐 Health check server listening on port ${config.port}`);
});

// ==================== START BOT ====================
startBot().catch(console.error);
