const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, PermissionsBitField } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('./config.js'); // API anahtarları ve bot token burada

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Bot giriş yapıldığında çalışacak
client.once('ready', async () => {
  console.log(`Bot başarıyla giriş yaptı: ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName('sesgpt')
      .setDescription('Sesli ve yazılı modda GPT ile iletişim kurar.')
      .addSubcommand(subcommand =>
        subcommand.setName('yazı')
          .setDescription('Yazı modunda iletişim kurar.')
      )
      .addSubcommand(subcommand =>
        subcommand.setName('ses')
          .setDescription('Ses modunda iletişim kurar.')
      )
  ].map(command => command.toJSON());

  const rest = new REST({ version: '10' }).setToken(config.mainBotToken);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('Slash komutları yüklendi.');
  } catch (error) {
    console.error('Komutlar yüklenirken hata oluştu:', error);
  }
});

// Slash komut dinleyicisi
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, options, guild, member } = interaction;

  if (commandName === 'sesgpt') {
    const subCommand = options.getSubcommand();

    if (subCommand === 'yazı') {
      // Yazı modunda iletişim kurma
      const channelName = `gpt-${member.user.username}`;
      const existingChannel = guild.channels.cache.find(ch => ch.name === channelName);

      if (existingChannel) {
        await interaction.reply(`Zaten bir özel kanalın var: ${existingChannel}`);
        return;
      }

      const channel = await guild.channels.create({
        name: channelName,
        type: 0, // Text Channel
        permissionOverwrites: [
          { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] }, // Herkese kapalı
          { id: member.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
          { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
        ]
      });

      await interaction.deferReply();  // Etkileşimi "beklemeye" al
      await interaction.editReply(`Özel kanal oluşturuldu: ${channel}`);
      channel.send('GPT ile iletişim kurmak için mesaj yazmaya başlayabilirsin.');
      listenToTextChannel(channel);
    } else if (subCommand === 'ses') {
      // Ses modunda iletişim kurma
      if (!member.voice.channel) {
        return interaction.reply('Ses kanalında değilsin!');
      }

      const connection = joinVoiceChannel({
        channelId: member.voice.channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false, // Sağırlaştırmayı kapatır
        selfMute: false  // Mikrofonu açık tutar
      });

      await interaction.deferReply();
      await interaction.editReply('Ses modunda iletişim kurmaya başladım. Konuşmaya başla!');
      listenToVoice(connection);
    }
  }
});

// Yazı kanalını dinle ve yanıt ver
function listenToTextChannel(channel) {
  client.on('messageCreate', async (message) => {
    if (message.channel.id !== channel.id || message.author.bot) return;

    const geminiResponse = await getGeminiResponse(message.content);

    await channel.send(geminiResponse);
  });
}

function listenToVoice(connection) {
  const receiver = connection.receiver;
  const mp3AudioPath = config.tempAudioPath;
  const audioWriteStream = fs.createWriteStream(mp3AudioPath);
  let silenceTimeout = null;  // Sessizlik zamanlayıcısı
  let isSpeaking = false; // Konuşma devam ediyor mu?

  receiver.speaking.on('start', (userId) => {
    console.log(`Kullanıcı konuşmaya başladı: ${userId}`);
    const audioStream = receiver.subscribe(userId);

    if (!audioStream) {
      console.error('Ses akışı alınamadı.');
      return;
    }

    audioStream.pipe(audioWriteStream);
    isSpeaking = true;  // Konuşma başladı

    audioStream.on('data', (chunk) => {
      // Ses verisi geldiğinde sessizlik kontrolünü sıfırla
      if (chunk.length < 3) {
        // 3 bayttan küçük ses verisi sessizlik olarak kabul edilir
        clearTimeout(silenceTimeout);
        silenceTimeout = setTimeout(async () => {
          console.log('Sessizlik tespit edildi');
          // Eğer sessizlik 5 saniye sürdüyse, konuşmayı bitir
          if (isSpeaking) {
            const transcription = await transcribeAudio(mp3AudioPath);
            const geminiResponse = await getGeminiResponse(transcription);
            const audioPath = await textToSpeech(geminiResponse);
            playResponseAudio(audioPath, connection);
            isSpeaking = false;  // Konuşma bitti
          }
        }, 5000);  // 5 saniye sessizlik süresi
      }
    });

    audioStream.on('end', async () => {
      console.log('Ses kaydı tamamlandı:', mp3AudioPath);
      if (isSpeaking) {
        const transcription = await transcribeAudio(mp3AudioPath);
        const geminiResponse = await getGeminiResponse(transcription);
        const audioPath = await textToSpeech(geminiResponse);
        playResponseAudio(audioPath, connection);
        isSpeaking = false;  // Konuşma bitti
      }
    });
  });

  receiver.speaking.on('end', () => {
    console.log('Kullanıcı konuşmayı bitirdi');
    // Kullanıcı konuşmayı bitirdiğinde de sessizlik kontrolünü başlat
    if (isSpeaking) {
      clearTimeout(silenceTimeout);
      silenceTimeout = setTimeout(async () => {
        console.log('Sessizlik tespit edildi');
        const transcription = await transcribeAudio(mp3AudioPath);
        const geminiResponse = await getGeminiResponse(transcription);
        const audioPath = await textToSpeech(geminiResponse);
        playResponseAudio(audioPath, connection);
        isSpeaking = false;  // Konuşma bitti
      }, 5000);  // 5 saniye sessizlik süresi
    }
  });
}


// OpenAI Whisper ile ses kaydını yazıya dökme
async function transcribeAudio(audioPath) {
  try {
    const audioFile = fs.createReadStream(audioPath);

    // API'ye ses dosyasını düzgün gönderme
    const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', audioFile, {
      headers: {
        'Authorization': `Bearer ${config.openAiApiKey}`,
        'Content-Type': 'audio/wav',  // Dosya formatını wav olarak değiştirdik
      },
      params: {
        model: 'whisper-1',
        language: 'tr',  // Türkçe dil seçeneği
      },
    });

    const transcription = response.data.text;
    console.log('Transkripsiyon sonucu:', transcription);
    return transcription;
  } catch (error) {
    console.error('Whisper API transkripsiyon hatası:', error);
    return 'Ses kaydından transkripsiyon alınamadı.';
  }
}


// GPT yanıtını al
async function getGeminiResponse(text) {
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${config.geminiApiKey}`,
      {
        contents: [{ parts: [{ text }] }]
      }
    );

    if (response.data && response.data.candidates && response.data.candidates[0] && response.data.candidates[0].content) {
      const geminiContent = response.data.candidates[0].content;
      console.log("Gemini Response Content: ", geminiContent);

      if (geminiContent && geminiContent.parts && geminiContent.parts[0] && geminiContent.parts[0].text) {
        return geminiContent.parts[0].text;
      }
    }
    return 'GPT yanıtı alınamadı.';
  } catch (error) {
    console.error('GPT API hatası:', error);
    return 'GPT API hatası oluştu.';
  }
}

// Metni sesli yanıt olarak çevir ve oynat
async function textToSpeech(text) {
  const outputPath = config.audioOutputPath;
  const speech = new gTTS(text, 'tr');  // Türkçe ses kullanıyoruz
  return new Promise((resolve, reject) => {
    speech.save(outputPath, (err) => {
      if (err) {
        reject('Ses dosyası oluşturulamadı.');
      } else {
        resolve(outputPath);
      }
    });
  });
}

// Sesli yanıtı oynat
function playResponseAudio(audioPath, connection) {
  const player = createAudioPlayer();
  const resource = createAudioResource(audioPath);
  player.play(resource);
  connection.subscribe(player);

  player.on(AudioPlayerStatus.Idle, () => {
    fs.unlinkSync(audioPath);  // Oynatıldıktan sonra ses dosyasını sil
  });
}

client.login(config.mainBotToken);
