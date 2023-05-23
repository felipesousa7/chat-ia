require('dotenv').config();

const AWS = require('aws-sdk');
const { Configuration, OpenAIApi } = require("openai");
const {Telegraf} = require('telegraf');
const axios = require('axios');
const fs = require('fs');

// Configurações da AWS
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});


// Inicializar a API do OpenAI


const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);


async function openAIRequest(transcriptionText) {
  try {
    const completion = await openai.createCompletion({
      model: "text-davinci-003",
      prompt: transcriptionText,
    });
    //console.log(completion.data.choices[0].text);
    return(completion.data.choices[0].text)
  } catch (error) {
    if (error.response) {
      console.log(error.response.status);
      console.log(error.response.data);
    } else {
      console.log(error.message);
    }
  }
}

// Configurações do bot do Telegram
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Função para realizar o download do arquivo de áudio do Telegram
async function downloadTelegramAudio(telegramAudioURI) {
  const response = await axios({
    url: telegramAudioURI,
    method: 'GET',
    responseType: 'stream'
  });

  const filePath = './file.ogg'; // Defina o caminho do arquivo de áudio local
  const writer = fs.createWriteStream(filePath);

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', () => resolve(filePath));
    writer.on('error', reject);
  });
}

// Função para carregar o arquivo de áudio no S3
async function uploadAudioToS3(localFilePath) {
  const s3 = new AWS.S3();

  const params = {
    Bucket: 'chat-teste',
    Key: 'audio/file.ogg', // Defina o caminho do arquivo de áudio no S3
    Body: fs.createReadStream(localFilePath)
  };

  return new Promise((resolve, reject) => {
    s3.upload(params, (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(data.Location);
      }
    });
  });
}

// Função para transcrever o áudio usando AWS Transcribe
async function transcribeAudio(telegramAudioURI) {
  try {
    const localFilePath = await downloadTelegramAudio(telegramAudioURI);
    const s3AudioURI = await uploadAudioToS3(localFilePath);

    const jobName = await startTranscriptionJob(s3AudioURI);
    const transcriptionResult = await getTranscriptionResult(jobName);

    // Continuar com o processamento do resultado da transcrição
    console.log('Transcription Result:', transcriptionResult);
  } catch (err) {
    console.error(err);
  }
}

// Função para iniciar o trabalho de transcrição usando AWS Transcribe
async function startTranscriptionJob(audioFileURI) {
  try {
    const transcribe = new AWS.TranscribeService();

    // Exclui o trabalho de transcrição existente, se houver
    await deleteExistingTranscriptionJob();

    const params = {
      LanguageCode: 'en-US',
      Media: {
        MediaFileUri: audioFileURI,
      },
      TranscriptionJobName: 'transcription_job' // Define o nome do trabalho como "transcription_job"
    };

    const response = await transcribe.startTranscriptionJob(params).promise();
    return response.TranscriptionJob.TranscriptionJobName;
  } catch (err) {
    throw err;
  }
}

// Função para excluir o trabalho de transcrição existente, se houver
async function deleteExistingTranscriptionJob() {
  try {
    const transcribe = new AWS.TranscribeService();
    const listResponse = await transcribe.listTranscriptionJobs().promise();

    // Verifica se há algum trabalho de transcrição com o nome "transcription_job"
    const existingJob = listResponse.TranscriptionJobSummaries.find(
      (job) => job.TranscriptionJobName === 'transcription_job'
    );

    if (existingJob) {
      // Exclui o trabalho de transcrição existente
      await transcribe.deleteTranscriptionJob({ TranscriptionJobName: existingJob.TranscriptionJobName }).promise();
    }
  } catch (err) {
    console.error('Error deleting existing transcription job:', err);
  }
}


function getTranscriptionResult(jobName) {
  return new Promise((resolve, reject) => {
    const transcribe = new AWS.TranscribeService();

    function checkTranscriptionStatus() {
      const params = {
        TranscriptionJobName: jobName,
      };

      transcribe.getTranscriptionJob(params, (err, data) => {
        if (err) {
          reject(err);
        } else {
          const jobStatus = data.TranscriptionJob.TranscriptionJobStatus;

          if (jobStatus === 'COMPLETED') {
            resolve(data.TranscriptionJob.Transcript.TranscriptFileUri);
          } else if (jobStatus === 'IN_PROGRESS') {
            // Se o trabalho ainda está em progresso, aguarda 5 segundos e verifica novamente
            setTimeout(checkTranscriptionStatus, 5000);
          } else {
            reject(new Error('Transcription job failed or not completed'));
          }
        }
      });
    }

    checkTranscriptionStatus();
  });
}

// Função para converter o texto em fala usando AWS Polly
function convertTextToSpeech(text) {
  return new Promise((resolve, reject) => {
    const polly = new AWS.Polly();

    const params = {
      OutputFormat: 'mp3',
      Text: text,
      TextType: 'text',
      VoiceId: 'Joanna'
    };

    polly.synthesizeSpeech(params, (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(data.AudioStream);
      }
    });
  });

}

//teste
function convertTextToSpeechTeste(text, outputPath) {
  return new Promise((resolve, reject) => {
    const polly = new AWS.Polly();

    const params = {
      OutputFormat: 'mp3',
      Text: text,
      TextType: 'text',
      VoiceId: 'Joanna'
    };

    polly.synthesizeSpeech(params, (err, data) => {
      if (err) {
        reject(err);
      } else {
        const audioStream = data.AudioStream;
        const fileStream = fs.createWriteStream(outputPath);

        audioStream.pipe(fileStream);

        fileStream.on('finish', () => {
          resolve(outputPath);
        });

        fileStream.on('error', (err) => {
          reject(err);
        });
      }
    });
  });
}





// Função para enviar a mensagem de áudio transcrito para o usuário no Telegram
function sendTranscriptionToTelegram( chatId , text) {
  return new Promise((resolve, reject) => {
    bot.telegram.sendMessage(chatId , text)
      .then(() => resolve())
      .catch((err) => reject(err));
  });
}

// Função para enviar o áudio para o usuário no Telegram
function sendAudioToTelegram(chatId, audio) {
  return new Promise((resolve, reject) => {
    bot.telegram.sendAudio(process.env.CHAT_ID, audio)
      .then(() => resolve())
      .catch((err) => reject(err));
  });
}
// Função para fazer o download do arquivo de texto transcrito
async function downloadTranscriptionText(transcriptionResult, outputPath) {
  try {
    const response = await axios({
      method: 'GET',
      url: transcriptionResult,
      responseType: 'stream',
    });

    const writeStream = fs.createWriteStream(outputPath);

    response.data.pipe(writeStream);

    return new Promise((resolve, reject) => {
      writeStream.on('finish', () => {
        resolve();
      });

      writeStream.on('error', (err) => {
        reject(err);
      });
    });
  } catch (err) {
    throw new Error('Error downloading transcription audio: ' + err.message);
  }
}

// Função para lidar com as mensagens de áudio recebidas pelo bot do Telegram
async function handleAudioMessage(ctx) {
  try {
    if (ctx.message && ctx.message.voice) {
      const audioFileId = ctx.message.voice.file_id;
      const audioFileLink = await bot.telegram.getFileLink(audioFileId);
      const audioFileURI = audioFileLink.href;

      // Transcrição do áudio usando AWS Transcribe
      await transcribeAudio(audioFileURI);
      const transcriptionResult = await getTranscriptionResult('transcription_job');
      await downloadTranscriptionText(transcriptionResult, './transcriptionText.json');
      const transcriptionText = await fs.promises.readFile('./transcriptionText.json', 'utf8');
      const transcriptionTextJson =JSON.parse(transcriptionText)
      const str = JSON.stringify(transcriptionTextJson.results.transcripts[0].transcript);
      // Envio do texto transcrito para a API da OpenAI
      console.log(str)
      const openAIResponse = await openAIRequest(str);
      console.log(openAIResponse)
      
      // Conversão da resposta da OpenAI em áudio usando AWS Polly
      //const speechAudio = await convertTextToSpeech(openAIResponse);

      // Envio do áudio resultante para o Telegram
      await sendTranscriptionToTelegram(ctx.chat.id,openAIResponse)
      //await sendAudioToTelegram(ctx.chat.id, speechAudio);
    } else {
      console.log('Mensagem de áudio inválida');
    }
  } catch (err) {
    console.error(err);
  }
}


// Registra o comando /start para iniciar o bot
bot.start((ctx) => ctx.reply('Bot started!'));
bot.on('voice', handleAudioMessage)

// Registra o tratamento de mensagens de áudio
//bot.on('message', handleAudioMessage)


// Inicia o bot do Telegram
bot.launch();
