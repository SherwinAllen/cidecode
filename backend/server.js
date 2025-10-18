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
const requests = {}; // requestId -> { status, step, progress, logs, method, message, otp, filePath, done, error, userConfirmed2FA, currentUrl }

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
    progress: 0,
    logs: [
      { timestamp: new Date().toISOString(), message: 'Starting data acquisition process...' }
    ],
    method: null,
    message: null,
    otp: null,
    filePath: null,
    done: false,
    error: null,
    userConfirmed2FA: false,
    currentUrl: null
  };

  // respond immediately with requestId so frontend can show UI
  res.json({ requestId });

  // Helper function to add logs and update progress
  const addLog = (message, progress = null) => {
    if (requests[requestId]) {
      requests[requestId].logs.push({
        timestamp: new Date().toISOString(),
        message: message
      });
      if (progress !== null) {
        requests[requestId].progress = progress;
      }
      console.log(`[${requestId}] ${message}`);
    }
  };

  // Helper function to update current URL
  const updateCurrentUrl = (url) => {
    if (requests[requestId]) {
      requests[requestId].currentUrl = url;
    }
  };

  // run background pipeline for this request
  (async () => {
    const cookiesScript = path.join(__dirname, 'GenerateAmazonCookie.js');
    const fetchScript = path.join(__dirname, 'fetchAlexaActivity.py');
    const syncScript = path.join(__dirname, 'SyncAudioTranscripts.py');
    const hashScript = path.join(__dirname, 'hash.py');
    const jsonPath = path.join(__dirname, '..', 'matched_audio_transcripts.json');

    const env = { ...process.env, AMAZON_EMAIL: email, AMAZON_PASSWORD: password, REQUEST_ID: requestId };

    try {
      // Step 1: Generating cookies
      requests[requestId].step = 'cookies';
      requests[requestId].status = 'running';
      addLog('Establishing secure connection...', 10);

      // spawn node script (so we can capture exit and not block main thread)
      const child = spawn('node', [cookiesScript], { env, stdio: ['ignore', 'pipe', 'pipe'] });

      let cookieOutput = '';
      child.stdout.on('data', (d) => {
        const data = d.toString();
        cookieOutput += data;
        
        // Extract and update current URL from cookie script output
        const urlMatch = data.match(/Current URL: (https?:\/\/[^\s]+)/);
        if (urlMatch) {
          updateCurrentUrl(urlMatch[1]);
        }
        
        // Look for specific progress indicators from the cookie script
        if (data.includes('Navigating to Alexa activity page') || data.includes('Checking authentication state')) {
          addLog('Verifying account credentials...', 20);
        }
        if (data.includes('2FA detected')) {
          addLog('Two-factor authentication required...', 25);
        }
        if (data.includes('Push notification page')) {
          addLog('Push notification sent to your device. Please approve to continue...', 30);
        }
        if (data.includes('Secure connection established')) {
          addLog('Secure connection established successfully', 35);
        }
        // Detect when we've successfully reached the target page
        if (data.includes('Successfully reached Alexa activity page')) {
          updateCurrentUrl('https://www.amazon.in/alexa-privacy/apd/rvh');
          addLog('Authentication completed successfully', 40);
        }
      });
      
      child.stderr.on('data', (d) => {
        console.error(`[${requestId}] cookies stderr: ${d.toString()}`);
      });

      const exitCode = await new Promise((resolve) => child.on('close', resolve));
      if (exitCode !== 0) {
        throw new Error(`GenerateAmazonCookie exited with ${exitCode}`);
      }
      
      // Ensure we mark authentication as complete
      if (!requests[requestId].currentUrl?.includes('/alexa-privacy/apd/')) {
        updateCurrentUrl('https://www.amazon.in/alexa-privacy/apd/rvh');
      }
      addLog('Authentication completed successfully', 40);

      // Step 2: fetch Alexa activity
      requests[requestId].step = 'fetch';
      requests[requestId].status = 'running';
      addLog('Starting data extraction from your account...', 45);

      let activityCount = 0;
      const fetchProcess = exec(`python3 "${fetchScript}"`, { env });
      
      fetchProcess.stdout.on('data', (data) => {
        const output = data.toString();
        console.log(`[${requestId}] fetchAlexaActivity stdout:`, output);
        
        // Parse activity count from Python script output
        const activityMatch = output.match(/Processing (\d+) to (\d+)/);
        if (activityMatch) {
          const currentCount = parseInt(activityMatch[2]);
          if (currentCount > activityCount) {
            activityCount = currentCount;
            const progress = Math.min(45 + Math.floor((currentCount / 50) * 40), 85); // 45-85% based on activities
            addLog(`Extracted data from ${currentCount} activities so far...`, progress);
          }
        }
        
        // Check for completion
        if (output.includes('PROCESSING COMPLETE') || output.includes('OPTIMIZED EXTRACTION COMPLETE')) {
          const finalMatch = output.match(/Total activities processed: (\d+)/);
          if (finalMatch) {
            activityCount = parseInt(finalMatch[1]);
            addLog(`Successfully extracted data from ${activityCount} activities`, 85);
          }
        }
      });
      
      fetchProcess.stderr.on('data', (data) => {
        console.error(`[${requestId}] fetchAlexaActivity stderr:`, data.toString());
      });

      await new Promise((resolve, reject) => {
        fetchProcess.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`fetchAlexaActivity exited with code ${code}`));
          }
        });
      });

      // Step 3: Sync transcripts
      requests[requestId].step = 'sync';
      addLog('Organizing extracted data...', 90);
      
      await new Promise((resolve, reject) => {
        exec(`python3 "${syncScript}"`, { env }, (err, stdout, stderr) => {
          if (err) {
            console.error(`[${requestId}] sync error:`, err);
            return reject(err);
          }
          console.log(`[${requestId}] SyncAudioTranscripts stdout:`, stdout);
          if (stderr) console.error(`[${requestId}] SyncAudioTranscripts stderr:`, stderr);
          
          // Parse final stats from sync script
          if (stdout.includes('Final mapping saved')) {
            const mappingMatch = stdout.match(/entries: (\d+)\)/);
            if (mappingMatch) {
              addLog(`Data organization complete (${mappingMatch[1]} entries processed)`, 95);
            }
          }
          resolve();
        });
      });

      // Step 4: hash and prepare JSON path for download
      requests[requestId].step = 'hash';
      addLog('Finalizing data package...', 98);
      
      await new Promise((resolve, reject) => {
        exec(`python3 "${hashScript}" "${jsonPath}"`, { env }, (err, stdout, stderr) => {
          if (err) {
            console.warn(`[${requestId}] hash error:`, err);
            // Don't reject here as hash failure shouldn't stop the download
          }
          console.log(`[${requestId}] hash output:`, stdout);
          resolve();
        });
      });

      requests[requestId].step = 'completed';
      requests[requestId].filePath = jsonPath;
      requests[requestId].done = true;
      requests[requestId].status = 'completed';
      addLog('Data extraction complete! Your file is ready for download.', 100);
      
      console.log(`[${requestId}] Pipeline completed successfully.`);
    } catch (err) {
      console.error(`[${requestId}] Pipeline error:`, err.message || err);
      requests[requestId].status = 'error';
      requests[requestId].error = (err && err.message) || String(err);
      
      // Add specific error messages for common issues
      if (err.message.includes('push notification') || err.message.includes('Push')) {
        addLog('Push notification was not approved in time. Please try again and make sure to approve the notification on your device.', null);
      } else if (err.message.includes('2FA') || err.message.includes('authentication')) {
        addLog('Authentication failed. Please check your credentials and try again.', null);
      } else if (err.message.includes('credentials') || err.message.includes('password')) {
        addLog('Invalid email or password. Please check your credentials and try again.', null);
      } else {
        addLog(`Error during data acquisition: ${err.message}`, null);
      }
    }
  })();
});

// Frontend polling endpoint for 2FA / progress - UPDATED: No status changes for push notification
app.get('/api/2fa-status/:id', (req, res) => {
  const id = req.params.id;
  const info = requests[id];
  if (!info) return res.status(404).send('Not found');
  
  // REMOVED: No automatic status changes for push notification
  // The frontend will handle modal closure based on URL changes only
  
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
  const { method, message, currentUrl } = req.body;
  const info = requests[id];
  if (!info) return res.status(404).send('Not found');
  info.method = method;
  info.message = message || null;
  info.status = 'waiting_for_2fa';
  if (currentUrl) {
    info.currentUrl = currentUrl;
  }
  console.log(`[${id}] 2FA update from headless script:`, method, message, currentUrl);
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