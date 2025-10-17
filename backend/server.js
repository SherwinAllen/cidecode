const express = require('express');
const cors = require('cors');
const app = express();
const path = require('path');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const { randomUUID } = require('crypto');

app.use(cors());
app.use(express.json());

// Simple GET endpoint used previously by SmartWatch flows
app.get('/api/packet-report', (req, res) => {
  const { email, password, source } = req.query;
  console.log('Received email:', email);
  console.log('Received password:', password);
  console.log('Request came from:', source);
  
  if (source === 'SmartWatch') {
    console.log('Source is SmartWatch');

    // Define the paths to the Python scripts.
    const script1 = path.join(__dirname, 'samsung_adb.py');
    const script2 = path.join(__dirname, 'report_gen.py');
    const script3 = path.join(__dirname, 'generateTimeline.py');

    // Execute all three Python scripts sequentially.
    exec(`python3 "${script1}" && python3 "${script2}" && python3 "${script3}"`, (err, stdout, stderr) => {
      if (err) {
        console.error('Error executing Python scripts:', err);
        res.status(500).send('Error generating DOCX file');
        return;
      }
      console.log('Python scripts output:', stdout);
      if (stderr) console.error('Python scripts stderr:', stderr);

      // Once the Python scripts complete, hash the DOCX file.
      const docxPath = path.join(__dirname, '..', 'Forensic_Log_Report.docx');
      const hashScript = path.join(__dirname, 'hash.py');
      exec(`python3 "${hashScript}" "${docxPath}"`, (hashErr, hashStdout, hashStderr) => {
        if (hashErr) {
          console.error('Error computing hash for DOCX file:', hashErr);
        } else {
          console.log('Hash for DOCX file:', (hashStdout || '').toString().trim());
        }
        // Now send the DOCX file.
        res.sendFile(docxPath, (sendErr) => {
          if (sendErr) {
            console.error('Error sending DOCX file:', sendErr);
            res.status(500).send('Error sending DOCX file');
          }
        });
      });
    });
  } else {
    console.log('Source is neither SmartWatch nor SmartAssistant');
    const jsonPath = path.join(__dirname, 'packet_report.json');
    res.sendFile(jsonPath, (err) => {
      if (err) {
        console.error('Error sending JSON file:', err);
        res.status(500).send('Error sending JSON file');
      }
    });
  }
});

// In-memory store for live SmartAssistant requests
const requests = {}; // requestId -> { status, step, method, message, otp, filePath, done, error, userConfirmed2FA }

// POST entrypoint from frontend SmartAssistant to start headless pipeline
app.post('/api/packet-report', (req, res) => {
  const { email, password, source } = req.body;
  console.log('Received email:', email);
  console.log('Received password:', password ? '***' : null);
  console.log('Request came from:', source);

  if (source !== 'SmartAssistant') {
    return res.status(400).send('Invalid source');
  }

  // create request id and initial state
  const requestId = randomUUID();
  requests[requestId] = {
    status: 'started',
    step: 'init',
    method: null,
    message: null,
    otp: null,
    filePath: null,
    done: false,
    error: null,
    userConfirmed2FA: false
  };

  // respond immediately with requestId so frontend can show UI
  res.json({ requestId });

  // run background pipeline for this request
  (async () => {
    const cookiesScript = path.join(__dirname, 'GenerateAmazonCookie.js');
    const fetchScript = path.join(__dirname, 'fetchAlexaActivity.py');
    const syncScript = path.join(__dirname, 'SyncAudioTranscripts.py');
    const hashScript = path.join(__dirname, 'hash.py');
    const jsonPath = path.join(__dirname, '..', 'matched_audio_transcripts.json');

    const env = { ...process.env, AMAZON_EMAIL: email, AMAZON_PASSWORD: password, REQUEST_ID: requestId };

    try {
      requests[requestId].step = 'cookies';
      requests[requestId].status = 'running';
      console.log(`[${requestId}] Step 1: Generating Amazon cookies (headless)...`);

      // spawn node script (so we can capture exit and not block main thread)
      const child = spawn('node', [cookiesScript], { env, stdio: ['ignore', 'pipe', 'pipe'] });

      child.stdout.on('data', (d) => console.log(`[${requestId}] cookies stdout: ${d.toString()}`));
      child.stderr.on('data', (d) => console.error(`[${requestId}] cookies stderr: ${d.toString()}`));

      const exitCode = await new Promise((resolve) => child.on('close', resolve));
      if (exitCode !== 0) {
        throw new Error(`GenerateAmazonCookie exited with ${exitCode}`);
      }
      console.log(`[${requestId}] Cookies generated.`);

      // Step 2: fetch Alexa activity
      requests[requestId].step = 'fetch';
      requests[requestId].status = 'running';
      console.log(`[${requestId}] Step 2: Fetching Alexa activity...`);
      await new Promise((resolve, reject) => {
        exec(`python3 "${fetchScript}"`, { env }, (err, stdout, stderr) => {
          if (err) {
            console.error(`[${requestId}] fetch error:`, err);
            return reject(err);
          }
          console.log(`[${requestId}] fetchAlexaActivity stdout:`, stdout);
          if (stderr) console.error(`[${requestId}] fetchAlexaActivity stderr:`, stderr);
          resolve();
        });
      });

      // Step 3: Sync transcripts
      requests[requestId].step = 'sync';
      console.log(`[${requestId}] Step 3: Syncing audio transcripts...`);
      await new Promise((resolve, reject) => {
        exec(`python3 "${syncScript}"`, { env }, (err, stdout, stderr) => {
          if (err) {
            console.error(`[${requestId}] sync error:`, err);
            return reject(err);
          }
          console.log(`[${requestId}] SyncAudioTranscripts stdout:`, stdout);
          if (stderr) console.error(`[${requestId}] SyncAudioTranscripts stderr:`, stderr);
          resolve();
        });
      });

      // Step 4: hash and prepare JSON path for download
      requests[requestId].step = 'hash';
      console.log(`[${requestId}] Step 4: Hashing JSON...`);
      await new Promise((resolve, reject) => {
        exec(`python3 "${hashScript}" "${jsonPath}"`, { env }, (err, stdout, stderr) => {
          if (err) {
            console.warn(`[${requestId}] hash error:`, err);
            return reject(err);
          }
          console.log(`[${requestId}] hash output:`, stdout);
          resolve();
        });
      });

      requests[requestId].step = 'completed';
      requests[requestId].filePath = jsonPath;
      requests[requestId].done = true;
      requests[requestId].status = 'completed';
      console.log(`[${requestId}] Pipeline completed successfully.`);
    } catch (err) {
      console.error(`[${requestId}] Pipeline error:`, err.message || err);
      requests[requestId].status = 'error';
      requests[requestId].error = (err && err.message) || String(err);
    }
  })();
});

// Frontend polling endpoint for 2FA / progress
app.get('/api/2fa-status/:id', (req, res) => {
  const id = req.params.id;
  const info = requests[id];
  if (!info) return res.status(404).send('Not found');
  res.json(info);
});

// Frontend sends OTP for a request id
app.post('/api/submit-otp/:id', (req, res) => {
  const id = req.params.id;
  const { otp } = req.body;
  const info = requests[id];
  if (!info) return res.status(404).send('Not found');
  info.otp = otp;
  info.status = 'otp_submitted';
  console.log(`[${id}] OTP received from frontend (masked): ${otp ? otp.replace(/\d/g,'*') : ''}`);
  res.json({ ok: true });
});

// Frontend confirms they completed a non-OTP 2FA (user pressed "I completed")
app.post('/api/confirm-2fa/:id', (req, res) => {
  const id = req.params.id;
  const info = requests[id];
  if (!info) return res.status(404).send('Not found');
  info.userConfirmed2FA = true;
  info.status = 'user_confirmed_2fa';
  res.json({ ok: true });
});

// Internal endpoint used by the headless node script to set detected method / message
app.post('/api/internal/2fa-update/:id', (req, res) => {
  const id = req.params.id;
  const { method, message } = req.body;
  const info = requests[id];
  if (!info) return res.status(404).send('Not found');
  info.method = method;
  info.message = message || null;
  info.status = 'waiting_for_2fa';
  console.log(`[${id}] 2FA update from headless script:`, method, message);
  res.json({ ok: true });
});

// Internal endpoint used by headless script to poll for OTP (if frontend submitted)
app.get('/api/internal/get-otp/:id', (req, res) => {
  const id = req.params.id;
  const info = requests[id];
  if (!info) return res.status(404).send('Not found');
  res.json({ otp: info.otp || null, userConfirmed2FA: !!info.userConfirmed2FA });
});

// Download endpoint once pipeline is complete
app.get('/api/download/:id', (req, res) => {
  const id = req.params.id;
  const info = requests[id];
  if (!info) return res.status(404).send('Not found');
  if (!info.done) return res.status(400).send('Not ready');
  const filePath = info.filePath;
  if (!filePath || !fs.existsSync(filePath)) return res.status(500).send('File not found');
  res.download(filePath);
});

const PORT = 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
