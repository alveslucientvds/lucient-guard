require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  AuditLogEvent,
  PermissionsBitField,
  ChannelType,
  ActivityType
} = require("discord.js");

const {
  joinVoiceChannel,
  getVoiceConnection,
  entersState,
  VoiceConnectionStatus
} = require("@discordjs/voice");

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.get("/", (req, res) => res.send("Guard bot aktif."));
app.listen(PORT, () => {
  console.log(`Web server çalışıyor. Port: ${PORT}`);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildModeration
  ]
});

const PREFIX = process.env.PREFIX || ".";
const OWNER_ID = process.env.OWNER_ID || "";
const TOKEN = process.env.TOKEN || "";
const WHITELIST_FILE = path.join(__dirname, "whitelist.json");

if (!TOKEN) {
  console.error("TOKEN bulunamadı. Render / .env ayarını kontrol et.");
}

if (!fs.existsSync(WHITELIST_FILE)) {
  fs.writeFileSync(WHITELIST_FILE, JSON.stringify([], null, 2));
}

function loadWhitelist() {
  try {
    const raw = fs.readFileSync(WHITELIST_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("Whitelist okunamadı:", err);
    return [];
  }
}

function saveWhitelist(data) {
  try {
    fs.writeFileSync(WHITELIST_FILE, JSON.stringify([...new Set(data)], null, 2));
  } catch (err) {
    console.error("Whitelist kaydedilemedi:", err);
  }
}

function isWhitelisted(userId) {
  if (!userId) return false;
  const whitelist = loadWhitelist();
  return whitelist.includes(userId) || userId === OWNER_ID;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function canIgnoreExecutor(guild, executorId) {
  if (!executorId || !guild) return true;
  if (executorId === client.user?.id) return true;
  if (executorId === guild.ownerId) return true;
  if (isWhitelisted(executorId)) return true;
  return false;
}

async function punishMember(guild, userId, reason) {
  try {
    if (!guild || !userId) return false;
    if (canIgnoreExecutor(guild, userId)) return false;

    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!me) {
      console.log("[GUARD] Bot member bilgisi alınamadı.");
      return false;
    }

    if (!me.permissions.has(PermissionsBitField.Flags.BanMembers)) {
      console.log("[GUARD] BanMembers yetkisi yok.");
      return false;
    }

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
      console.log(`[GUARD] Üye bulunamadı: ${userId}`);
      return false;
    }

    if (!member.bannable) {
      console.log(`[GUARD] ${userId} bannable değil. Bot rolü üstte olmayabilir.`);
      return false;
    }

    await member.ban({ reason });
    console.log(`[GUARD] ${userId} banlandı. Sebep: ${reason}`);
    return true;
  } catch (err) {
    console.error("punishMember hata:", err);
    return false;
  }
}

async function getRelevantAuditEntry(guild, type, targetId, extraDelay = 1800) {
  try {
    if (!guild) return null;

    await wait(extraDelay);

    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!me || !me.permissions.has(PermissionsBitField.Flags.ViewAuditLog)) {
      console.log("[GUARD] ViewAuditLog yetkisi yok.");
      return null;
    }

    const logs = await guild.fetchAuditLogs({
      type,
      limit: 10
    });

    const now = Date.now();

    const entry = logs.entries.find(e => {
      const executorId = e.executor?.id;
      const entryTargetId = e.target?.id;
      const created = e.createdTimestamp || 0;

      if (!executorId || !entryTargetId) return false;
      if (targetId && entryTargetId !== targetId) return false;
      if (now - created > 20000) return false;

      return true;
    });

    return entry || null;
  } catch (err) {
    console.error("Audit log alınamadı:", err);
    return null;
  }
}

async function getRecentAuditExecutor(guild, type, extraDelay = 1200) {
  try {
    if (!guild) return null;

    await wait(extraDelay);

    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!me || !me.permissions.has(PermissionsBitField.Flags.ViewAuditLog)) {
      console.log("[GUARD] ViewAuditLog yetkisi yok.");
      return null;
    }

    const logs = await guild.fetchAuditLogs({
      type,
      limit: 10
    });

    const entry = logs.entries.find(e => {
      const created = e.createdTimestamp || 0;
      return Date.now() - created <= 15000;
    });

    return entry || null;
  } catch (err) {
    console.error("Recent audit alınamadı:", err);
    return null;
  }
}

client.once("ready", async () => {
  console.log(`${client.user.tag} aktif.`);

  client.user.setPresence({
    activities: [
      {
        name: "Guard sistemi aktif",
        type: ActivityType.Watching
      }
    ],
    status: "online"
  });
});

/* =========================
   GUARD SİSTEMİ
========================= */

// Sağ tık ban koruması
client.on("guildBanAdd", async (ban) => {
  try {
    const guild = ban.guild;
    const targetId = ban.user.id;

    const entry = await getRelevantAuditEntry(
      guild,
      AuditLogEvent.MemberBanAdd,
      targetId,
      2200
    );

    if (!entry) {
      console.log("[GUARD] Ban audit entry bulunamadı.");
      return;
    }

    const executor = entry.executor;
    if (!executor) return;
    if (canIgnoreExecutor(guild, executor.id)) return;

    await punishMember(
      guild,
      executor.id,
      `Guard: İzinsiz sağ tık ban (${ban.user.tag})`
    );

    console.log(`[GUARD] ${executor.tag} izinsiz ban attı, cezalandırıldı.`);
  } catch (err) {
    console.error("guildBanAdd hata:", err);
  }
});

// Sağ tık kick koruması
client.on("guildMemberRemove", async (member) => {
  try {
    const guild = member.guild;
    const targetId = member.id;

    const entry = await getRelevantAuditEntry(
      guild,
      AuditLogEvent.MemberKick,
      targetId,
      1800
    );

    if (!entry) return;

    const executor = entry.executor;
    if (!executor) return;
    if (canIgnoreExecutor(guild, executor.id)) return;

    await punishMember(
      guild,
      executor.id,
      `Guard: İzinsiz sağ tık kick (${member.user.tag})`
    );

    console.log(`[GUARD] ${executor.tag} izinsiz kick attı, cezalandırıldı.`);
  } catch (err) {
    console.error("guildMemberRemove hata:", err);
  }
});

// Kanal oluşturma koruması
client.on("channelCreate", async (channel) => {
  try {
    const guild = channel.guild;
    if (!guild) return;

    const entry = await getRecentAuditExecutor(guild, AuditLogEvent.ChannelCreate, 1400);
    if (!entry || !entry.executor) return;

    const executor = entry.executor;
    if (canIgnoreExecutor(guild, executor.id)) return;

    await punishMember(guild, executor.id, "Guard: İzinsiz kanal oluşturma");

    if (channel.deletable) {
      await channel.delete("Guard: İzinsiz oluşturulan kanal silindi").catch(() => {});
    }

    console.log(`[GUARD] ${executor.tag} izinsiz kanal oluşturdu.`);
  } catch (err) {
    console.error("channelCreate hata:", err);
  }
});

// Kanal silme koruması
client.on("channelDelete", async (channel) => {
  try {
    const guild = channel.guild;
    if (!guild) return;

    const entry = await getRecentAuditExecutor(guild, AuditLogEvent.ChannelDelete, 1400);
    if (!entry || !entry.executor) return;

    const executor = entry.executor;
    if (canIgnoreExecutor(guild, executor.id)) return;

    await punishMember(guild, executor.id, "Guard: İzinsiz kanal silme");

    console.log(`[GUARD] ${executor.tag} izinsiz kanal sildi.`);
  } catch (err) {
    console.error("channelDelete hata:", err);
  }
});

// Kanal düzenleme koruması
client.on("channelUpdate", async (oldChannel, newChannel) => {
  try {
    const guild = newChannel.guild;
    if (!guild) return;

    const entry = await getRecentAuditExecutor(guild, AuditLogEvent.ChannelUpdate, 1400);
    if (!entry || !entry.executor) return;

    const executor = entry.executor;
    if (canIgnoreExecutor(guild, executor.id)) return;

    await punishMember(guild, executor.id, "Guard: İzinsiz kanal düzenleme");

    console.log(`[GUARD] ${executor.tag} izinsiz kanal düzenledi.`);
  } catch (err) {
    console.error("channelUpdate hata:", err);
  }
});

/* =========================
   KOMUTLAR
========================= */

client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;
    if (message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const command = args.shift()?.toLowerCase();

    const restrictedCommands = ["wl-ekle", "wl-sil", "wl-liste", "ban", "kick", "join", "leave"];

    if (restrictedCommands.includes(command) && !isWhitelisted(message.author.id)) {
      return message.reply("Bu komutu kullanmak için whitelistte olman gerekiyor.");
    }

    if (command === "wl-ekle") {
      const input = args[0];
      if (!input) return message.reply("Bir kullanıcı etiketle ya da ID yaz.");

      const user =
        message.mentions.users.first() ||
        await client.users.fetch(input).catch(() => null);

      if (!user) {
        return message.reply("Geçerli bir kullanıcı etiketle ya da ID yaz.");
      }

      const whitelist = loadWhitelist();
      if (whitelist.includes(user.id)) {
        return message.reply("Bu kullanıcı zaten whitelistte.");
      }

      whitelist.push(user.id);
      saveWhitelist(whitelist);

      return message.reply(`${user.tag} whitelist'e eklendi.`);
    }

    if (command === "wl-sil") {
      const input = args[0];
      if (!input) return message.reply("Bir kullanıcı etiketle ya da ID yaz.");

      const user =
        message.mentions.users.first() ||
        await client.users.fetch(input).catch(() => null);

      if (!user) {
        return message.reply("Geçerli bir kullanıcı etiketle ya da ID yaz.");
      }

      let whitelist = loadWhitelist();
      if (!whitelist.includes(user.id)) {
        return message.reply("Bu kullanıcı whitelistte değil.");
      }

      whitelist = whitelist.filter(id => id !== user.id);
      saveWhitelist(whitelist);

      return message.reply(`${user.tag} whitelist'ten çıkarıldı.`);
    }

    if (command === "wl-liste") {
      const whitelist = loadWhitelist();
      if (whitelist.length === 0) {
        return message.reply("Whitelist boş.");
      }

      const text = whitelist
        .map((id, i) => `${i + 1}. <@${id}> (\`${id}\`)`)
        .join("\n");

      return message.reply(`**Whitelist:**\n${text}`);
    }

    if (command === "ban") {
      const me = message.guild.members.me || await message.guild.members.fetchMe().catch(() => null);
      if (!me || !me.permissions.has(PermissionsBitField.Flags.BanMembers)) {
        return message.reply("Ban yetkim yok.");
      }

      const input = args[0];
      if (!input) {
        return message.reply("Banlanacak kullanıcıyı etiketle ya da ID yaz.");
      }

      const target =
        message.mentions.members.first() ||
        await message.guild.members.fetch(input).catch(() => null);

      if (!target) {
        return message.reply("Geçerli bir kullanıcı etiketle ya da ID yaz.");
      }

      if (target.id === message.author.id) {
        return message.reply("Kendini banlayamazsın.");
      }

      if (target.id === client.user.id) {
        return message.reply("Beni banlayamazsın.");
      }

      if (target.id === message.guild.ownerId) {
        return message.reply("Sunucu sahibini banlayamazsın.");
      }

      const reason = args.slice(1).join(" ") || "Sebep belirtilmedi";

      if (!target.bannable) {
        return message.reply("Bu kullanıcıyı banlayamıyorum.");
      }

      await target.ban({ reason: `${message.author.tag}: ${reason}` });
      return message.reply(`${target.user.tag} banlandı. Sebep: ${reason}`);
    }

    if (command === "kick") {
      const me = message.guild.members.me || await message.guild.members.fetchMe().catch(() => null);
      if (!me || !me.permissions.has(PermissionsBitField.Flags.KickMembers)) {
        return message.reply("Kick yetkim yok.");
      }

      const input = args[0];
      if (!input) {
        return message.reply("Atılacak kullanıcıyı etiketle ya da ID yaz.");
      }

      const target =
        message.mentions.members.first() ||
        await message.guild.members.fetch(input).catch(() => null);

      if (!target) {
        return message.reply("Geçerli bir kullanıcı etiketle ya da ID yaz.");
      }

      if (target.id === message.author.id) {
        return message.reply("Kendini kickleyemezsin.");
      }

      if (target.id === client.user.id) {
        return message.reply("Beni kickleyemezsin.");
      }

      if (target.id === message.guild.ownerId) {
        return message.reply("Sunucu sahibini kickleyemezsin.");
      }

      const reason = args.slice(1).join(" ") || "Sebep belirtilmedi";

      if (!target.kickable) {
        return message.reply("Bu kullanıcıyı kickleyemiyorum.");
      }

      await target.kick(`${message.author.tag}: ${reason}`);
      return message.reply(`${target.user.tag} sunucudan atıldı. Sebep: ${reason}`);
    }

    if (command === "join") {
      const voiceChannel = message.member?.voice?.channel;

      if (!voiceChannel) {
        return message.reply("Önce bir ses kanalına girmen lazım.");
      }

      if (
        voiceChannel.type !== ChannelType.GuildVoice &&
        voiceChannel.type !== ChannelType.GuildStageVoice
      ) {
        return message.reply("Geçerli bir ses kanalında değilsin.");
      }

      const me = message.guild.members.me || await message.guild.members.fetchMe().catch(() => null);
      if (!me) return message.reply("Bot bilgime erişemedim.");

      const permissions = voiceChannel.permissionsFor(me);

      if (
        !permissions?.has(PermissionsBitField.Flags.Connect) ||
        !permissions?.has(PermissionsBitField.Flags.ViewChannel)
      ) {
        return message.reply("Bu ses kanalına girme yetkim yok.");
      }

      const existing = getVoiceConnection(message.guild.id);
      if (existing) {
        existing.destroy();
      }

      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: true
      });

      await entersState(connection, VoiceConnectionStatus.Ready, 15000).catch(() => null);

      return message.reply(`Ses kanalına girdim: **${voiceChannel.name}**`);
    }

    if (command === "leave") {
      const connection = getVoiceConnection(message.guild.id);

      if (!connection) {
        return message.reply("Zaten bir ses kanalında değilim.");
      }

      connection.destroy();
      return message.reply("Ses kanalından çıktım.");
    }
  } catch (err) {
    console.error("Komut hatası:", err);
    return message.reply("Bir hata oluştu.");
  }
});

/* =========================
   ANTI-CRASH
========================= */

process.on("unhandledRejection", reason => {
  console.error("Unhandled Rejection:", reason);
});

process.on("uncaughtException", err => {
  console.error("Uncaught Exception:", err);
});

process.on("uncaughtExceptionMonitor", err => {
  console.error("Uncaught Exception Monitor:", err);
});

client.login(TOKEN).catch(err => {
  console.error("Bot giriş hatası:", err);
});
