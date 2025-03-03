// ============================
// 1. Imports e Configurações
// ============================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const tmi = require('tmi.js');
const fetch = require('node-fetch');
const fs = require('fs');
const session = require('express-session');
const passport = require('passport');
const TwitchStrategy = require('passport-twitch-new').Strategy;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ============================
// 2. Configuração dos Middlewares Express e Sessão
// ============================
app.use(express.static('public'));
app.use(express.json());
app.use(session({
  secret: 'seu-segredo_aqui',
  resave: false,
  saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());

// ============================
// 3. Configuração do OAuth com Twitch
// ============================
const TWITCH_CLIENT_ID = 'hsziksnh5mqsq2kvpqfp3m8x42up82';
const TWITCH_CLIENT_SECRET = 'fz1egldkiqp9434ayi0rnyfv7rfpmb';
const CALLBACK_URL = 'http://localhost:3000/auth/twitch/callback';

passport.use(new TwitchStrategy({
  clientID: TWITCH_CLIENT_ID,
  clientSecret: TWITCH_CLIENT_SECRET,
  callbackURL: CALLBACK_URL,
  scope: "user:read:email"
}, (accessToken, refreshToken, profile, done) => {
  // Aqui podemos salvar o perfil se necessário
  return done(null, profile);
}));

passport.serializeUser((user, done) => {
  done(null, user);
});
passport.deserializeUser((obj, done) => {
  done(null, obj);
});

// ============================
// 4. Rotas de Autenticação Twitch
// ============================
app.get('/auth/twitch', passport.authenticate('twitch'));
app.get('/auth/twitch/callback',
  passport.authenticate('twitch', { failureRedirect: '/' }),
  (req, res) => {
    // Após login, adiciona o canal (nome do usuário) para monitoramento
    const username = req.user.login.toLowerCase();
    let config = loadConfig();
    if (!config.channels.includes(username)) {
      config.channels.push(username);
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      // Adiciona o canal ao bot do Twitch
      client.join(username);
    }
    res.redirect('/');
  }
);

// ============================
// 5. Carregar Configuração dos Canais
// ============================
const configPath = 'config.json';
function loadConfig() {
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }
  return { channels: [] };
}
let config = loadConfig();

// ============================
// 6. Configuração do Bot do Twitch
// ============================
const client = new tmi.Client({
  options: { debug: true },
  identity: {
    username: 'SoObservandoVc',
    password: 'oauth:k9b0ajml22yjr9ulbobykr4cg3275o'
  },
  channels: config.channels
});
client.connect();

// ============================
// 7. Gerenciamento das Filas de Músicas para Vários Canais
// ============================
// Cada canal terá sua própria fila e flag de reprodução
let songQueues = {}; // Ex.: { canal1: [ {title, thumbnail, videoId}, ... ] }
let isPlaying = {};  // Ex.: { canal1: true/false, ... }

// Função para garantir que uma fila exista para o canal
function ensureQueue(channel) {
  if (!songQueues[channel]) {
    songQueues[channel] = [];
    isPlaying[channel] = false;
  }
}

// Função para obter informações do vídeo de forma anônima (via oEmbed)
async function getSongInfo(url) {
  let videoId;
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.hostname.includes("youtube.com")) {
      videoId = parsedUrl.searchParams.get("v");
    } else if (parsedUrl.hostname.includes("youtu.be")) {
      videoId = parsedUrl.pathname.slice(1);
    } else {
      return null;
    }
  } catch (error) {
    return null;
  }
  const oEmbedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  const response = await fetch(oEmbedUrl);
  if (!response.ok) return null;
  const data = await response.json();
  return {
    title: data.title,
    thumbnail: data.thumbnail_url,
    videoId: videoId
  };
}

// ============================
// 8. Comandos do Chat do Twitch
// ============================
client.on('message', async (channel, tags, message, self) => {
  if (self) return;
  // Remove o '#' e converte para lowercase para manter a consistência
  const channelName = channel.replace('#', '').toLowerCase();
  ensureQueue(channelName);
  
  const args = message.split(' ');
  const command = args[0].toLowerCase();
  
  if (command === '!sr' && args[1]) {
    const songInfo = await getSongInfo(args[1]);
    console.log(`Song info para ${args[1]}:`, songInfo); // Debug
    if (!songInfo) return;
    songQueues[channelName].push(songInfo);
    // Emite para os clientes conectados à sala do canal (nome normalizado)
    io.to(channelName).emit('queueUpdated', songQueues[channelName]);
    playNextSong(channelName);
  }
  
  if (command === '!skip') {
    if (songQueues[channelName].length > 0) {
      songQueues[channelName].shift();
      io.to(channelName).emit('queueUpdated', songQueues[channelName]);
      playNextSong(channelName);
    }
  }
  
  if (command === '!queue') {
    if (songQueues[channelName].length === 0) return;
    const queueMsg = songQueues[channelName].map((s, i) => `${i + 1}. ${s.title}`).join(' | ');
    client.say(channel, `Fila: ${queueMsg}`);
  }
  
  if (command === '!remove' && args[1]) {
    const index = parseInt(args[1]) - 1;
    if (index >= 0 && index < songQueues[channelName].length) {
      songQueues[channelName].splice(index, 1);
      io.to(channelName).emit('queueUpdated', songQueues[channelName]);
    }
  }
});

// ============================
// 9. Controle do Overlay e Reprodução (Socket.io)
// ============================
function playNextSong(channelName) {
  ensureQueue(channelName);
  if (isPlaying[channelName] || songQueues[channelName].length === 0) return;
  isPlaying[channelName] = true;
  const song = songQueues[channelName][0];
  io.to(channelName).emit('playSong', song);
}

io.on('connection', (socket) => {
  // O overlay deve enviar o parâmetro "channel" via query string, convertemos para lowercase
  const channelName = socket.handshake.query.channel ? socket.handshake.query.channel.toLowerCase() : null;
  console.log(`Socket conectado para ${channelName}`);
  if (channelName) {
    socket.join(channelName);
    ensureQueue(channelName);
    socket.emit('queueUpdated', songQueues[channelName]);
  }
  
  socket.on('songFinished', () => {
    const channelName = socket.handshake.query.channel ? socket.handshake.query.channel.toLowerCase() : null;
    if (!channelName) return;
    console.log(`Song finished para ${channelName}`);
    isPlaying[channelName] = false;
    songQueues[channelName].shift();
    playNextSong(channelName);
  });
});

// ============================
// 10. Rotas para Gerenciamento de Canais e Usuário
// ============================
app.get('/config.json', (req, res) => {
  res.json(config);
});

app.post('/update-channels', (req, res) => {
  let newChannels = req.body.channels;
  if (req.body.channel) {
    if (!newChannels.includes(req.body.channel)) {
      newChannels.push(req.body.channel);
    }
  }
  config.channels = newChannels;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  
  client.channels.forEach(channel => client.part(channel));
  client.opts.channels = config.channels;
  config.channels.forEach(channel => client.join(channel));
  res.json({ success: true, channels: config.channels });
});

app.get('/user', (req, res) => {
  if (req.isAuthenticated()) {
    res.json({ user: req.user });
  } else {
    res.json({ user: null });
  }
});

// ============================
// 11. Inicialização do Servidor
// ============================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
