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
  getVoiceConnection
} = require("@discordjs/voice");

const express = require("express");
const fs = require("fs");

const app = express();
app.get("/", (req, res) => res.send("Guard bot aktif."));
app.listen(process.env.PORT || 3000, () => {
  console.log("Web server çalışıyor.");
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
const WHITELIST_FILE = "./whitelist.json";

if (!fs.existsSync(WHITELIST_FILE)) {
  fs.writeFileSync(WHITELIST_FILE, JSON.stringify([], null, 2));
}

function loadWhitelist() {
  try {
    return JSON.parse(fs.readFileSync(WHITELIST_FILE, "utf8"));
  } catch (err) {
    console.error("Whitelist okunamadı:", err);
    return [];
  }
}

function saveWhitelist(data) {
  try {
    fs.writeFileSync(WHITELIST_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Whitelist kaydedilemedi:", err);
  }
}

function isWhitelisted(userId) {
  const whitelist = loadWhitelist();
  return whitelist.includes(userId) || userId === OWNER_ID;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function punishMember(guild, userId, reason) {
  try {
    if (!guild || !userId) return;
    if (isWhitelisted(userId)) return;
    if (userId === guild.ownerId) return;
    if (userId === client.user.id) return;

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return;

    if (!member.bannable) {
      console.log(`[GUARD] ${userId} bannable değil. Bot rolü üstte olmayabilir.`);
      return;
    }

    await member.ban({ reason });
    console.log(`[GUARD] ${userId} banlandı. Sebep: ${reason}`);
  } catch (err) {
    console.error("punishMember hata:", err);
  }
}

async function getRelevantAuditEntry(guild, type, targetId) {
  try {
    await wait(1800);

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
      if (entryTargetId !== targetId) return false;
      if (now - created > 20000) return false;

      return true;
    });

    return entry || null;
  } catch (err) {
    console.error("Audit log alınamadı:", err);
    return null;
  }
}

client.once("ready", () => {
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
      targetId
    );

    if (!entry) {
      console.log("[GUARD] Ban audit entry bulunamadı.");
      return;
    }

    const executor = entry.executor;
    if (!executor) return;

    if (isWhitelisted(executor.id)) {
      console.log(`[GUARD] ${executor.tag} whitelistte, ban işlemi serbest.`);
      return;
    }

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
      targetId
    );

    if (!entry) return;

    const executor = entry.executor;
    if (!executor) return;

    if (isWhitelisted(executor.id)) return;

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

    await wait(1200);

    const logs = await guild.fetchAuditLogs({
      type: AuditLogEvent.ChannelCreate,
      limit: 10
    });

    const entry = logs.entries.find(e => {
      const created = e.createdTimestamp || 0;
      return Date.now() - created <= 15000;
    });

    if (!entry || !entry.executor) return;

    const executor = entry.executor;
    if (isWhitelisted(executor.id)) return;

    await punishMember(guild, executor.id, "Guard: İzinsiz kanal oluşturma");
    await channel.delete().catch(() => {});

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

    await wait(1200);

    const logs = await guild.fetchAuditLogs({
      type: AuditLogEvent.ChannelDelete,
      limit: 10
    });

    const entry = logs.entries.find(e => {
      const created = e.createdTimestamp || 0;
      return Date.now() - created <= 15000;
    });

    if (!entry || !entry.executor) return;

    const executor = entry.executor;
    if (isWhitelisted(executor.id)) return;

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

    await wait(1200);

    const logs = await guild.fetchAuditLogs({
      type: AuditLogEvent.ChannelUpdate,
      limit: 10
    });

    const entry = logs.entries.find(e => {
      const created = e.createdTimestamp || 0;
      return Date.now() - created <= 15000;
    });

    if (!entry || !entry.executor) return;

    const executor = entry.executor;
    if (isWhitelisted(executor.id)) return;

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

    if (
      ["wl-ekle", "wl-sil", "wl-liste", "ban", "kick", "join", "leave"].includes(command) &&
      !isWhitelisted(message.author.id)
    ) {
      return message.reply("Bu komutu kullanmak için whitelistte olman gerekiyor.");
    }

    // .wl-ekle
    if (command === "wl-ekle") {
      const user =
        message.mentions.users.first() ||
        await client.users.fetch(args[0]).catch(() => null);

      if (!user) {
        return message.reply("Bir kullanıcı etiketle ya da ID yaz.");
      }

      const whitelist = loadWhitelist();
      if (whitelist.includes(user.id)) {
        return message.reply("Bu kullanıcı zaten whitelistte.");
      }

      whitelist.push(user.id);
      saveWhitelist(whitelist);

      return message.reply(`${user.tag} whitelist'e eklendi.`);
    }

    // .wl-sil
    if (command === "wl-sil") {
      const user =
        message.mentions.users.first() ||
        await client.users.fetch(args[0]).catch(() => null);

      if (!user) {
        return message.reply("Bir kullanıcı etiketle ya da ID yaz.");
      }

      let whitelist = loadWhitelist();
      if (!whitelist.includes(user.id)) {
        return message.reply("Bu kullanıcı whitelistte değil.");
      }

      whitelist = whitelist.filter(id => id !== user.id);
      saveWhitelist(whitelist);

      return message.reply(`${user.tag} whitelist'ten çıkarıldı.`);
    }

    // .wl-liste
    if (command === "wl-liste") {
      const whitelist = loadWhitelist();
      if (whitelist.length === 0) {
        return message.reply("Whitelist boş.");
      }

      const text = whitelist.map((id, i) => `${i + 1}. <@${id}> (\`${id}\`)`).join("\n");
      return message.reply(`**Whitelist:**\n${text}`);
    }

    // .ban
    if (command === "ban") {
      if (!message.guild.members.me.permissions.has(PermissionsBitField.Flags.BanMembers)) {
        return message.reply("Ban yetkim yok.");
      }

      const target =
        message.mentions.members.first() ||
        await message.guild.members.fetch(args[0]).catch(() => null);

      if (!target) {
        return message.reply("Banlanacak kullanıcıyı etiketle ya da ID yaz.");
      }

      if (target.id === message.author.id) {
        return message.reply("Kendini banlayamazsın.");
      }

      if (target.id === client.user.id) {
        return message.reply("Beni banlayamazsın.");
      }

      const reason = args.slice(1).join(" ") || "Sebep belirtilmedi";

      if (!target.bannable) {
        return message.reply("Bu kullanıcıyı banlayamıyorum.");
      }

      await target.ban({ reason: `${message.author.tag}: ${reason}` });
      return message.reply(`${target.user.tag} banlandı. Sebep: ${reason}`);
    }

    // .kick
    if (command === "kick") {
      if (!message.guild.members.me.permissions.has(PermissionsBitField.Flags.KickMembers)) {
        return message.reply("Kick yetkim yok.");
      }

      const target =
        message.mentions.members.first() ||
        await message.guild.members.fetch(args[0]).catch(() => null);

      if (!target) {
        return message.reply("Atılacak kullanıcıyı etiketle ya da ID yaz.");
      }

      if (target.id === message.author.id) {
        return message.reply("Kendini kickleyemezsin.");
      }

      if (target.id === client.user.id) {
        return message.reply("Beni kickleyemezsin.");
      }

      const reason = args.slice(1).join(" ") || "Sebep belirtilmedi";

      if (!target.kickable) {
        return message.reply("Bu kullanıcıyı kickleyemiyorum.");
      }

      await target.kick(`${message.author.tag}: ${reason}`);
      return message.reply(`${target.user.tag} sunucudan atıldı. Sebep: ${reason}`);
    }

    // .join
    if (command === "join") {
      const voiceChannel = message.member.voice.channel;

      if (!voiceChannel) {
        return message.reply("Önce bir ses kanalına girmen lazım.");
      }

      if (
        voiceChannel.type !== ChannelType.GuildVoice &&
        voiceChannel.type !== ChannelType.GuildStageVoice
      ) {
        return message.reply("Geçerli bir ses kanalında değilsin.");
      }

      const permissions = voiceChannel.permissionsFor(message.guild.members.me);

      if (
        !permissions.has(PermissionsBitField.Flags.Connect) ||
        !permissions.has(PermissionsBitField.Flags.ViewChannel)
      ) {
        return message.reply("Bu ses kanalına girme yetkim yok.");
      }

      joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: true
      });

      return message.reply(`Ses kanalına girdim: **${voiceChannel.name}**`);
    }

    // .leave
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

client.login(process.env.TOKEN);