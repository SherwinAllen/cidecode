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
    exec(`python "${script1}" && python "${script2}" && python "${script3}"`, (err, stdout, stderr) => {
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
      exec(`python "${hashScript}" "${docxPath}"`, (hashErr, hashStdout, hashStderr) => {
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
const requests = {}; // requestId -> { status, step, progress, logs, method, message, otp, filePath, done, error, userConfirmed2FA, currentUrl, errorType }

// Clean up previous pipeline files
function cleanupPreviousPipelineFiles() {
  const filesToCleanup = [
    'backend/audio_urls.json',
    'alexa_activity_log.txt', 
    'matched_audio_transcripts.json',
    'enhanced_audio_transcripts.json',
    'smart_assistant_report.html'
  ];
  
  console.log('🧹 Cleaning up previous pipeline files...');
  
  filesToCleanup.forEach(filePath => {
    try {
      const fullPath = path.join(__dirname, '..', filePath);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        console.log(`   Deleted: ${filePath}`);
      }
    } catch (error) {
      console.log(`   Could not delete ${filePath}: ${error.message}`);
    }
  });
  
  // Also clean up downloaded_audio directory if it exists
  const audioDir = path.join(__dirname, '..', 'downloaded_audio');
  try {
    if (fs.existsSync(audioDir)) {
      fs.readdirSync(audioDir).forEach(file => {
        fs.unlinkSync(path.join(audioDir, file));
      });
      fs.rmdirSync(audioDir);
      console.log('   Deleted: downloaded_audio directory');
    }
  } catch (error) {
    console.log(`   Could not clean up audio directory: ${error.message}`);
  }
}

// POST entrypoint from frontend SmartAssistant to start headless pipeline
app.post('/api/packet-report', (req, res) => {
  const { email, password, source } = req.body;
  console.log('Received email:', email);
  console.log('Received password:', password ? '***' : null);
  console.log('Request came from:', source);

  if (source !== 'SmartAssistant') {
    return res.status(400).send('Invalid source');
  }

  // Clean up previous pipeline files before starting new one
  cleanupPreviousPipelineFiles();

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
    errorType: null,
    userConfirmed2FA: false,
    currentUrl: null,
    showOtpModal: false,
    otpError: null,
    // NEW: Track child processes for cancellation
    childProcesses: []
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

  // NEW: Enhanced cancelPipeline function to handle user cancellation
  const cancelPipeline = async (errorType, errorMessage) => {
    if (requests[requestId]) {
      console.log(`[${requestId}] Cancelling pipeline due to: ${errorType}`);
      
      // Add cancellation log
      if (requests[requestId].logs) {
        requests[requestId].logs.push({
          timestamp: new Date().toISOString(),
          message: 'Data acquisition cancelled by user. Cleaning up...'
        });
      }
      
      // Kill all child processes gracefully
      const cleanupPromises = requests[requestId].childProcesses.map(async (child) => {
        try {
          if (!child.killed) {
            console.log(`[${requestId}] Terminating child process...`);
            
            // For spawn processes, use kill with SIGTERM first, then SIGKILL
            if (child.kill) {
              child.kill('SIGTERM');
              console.log(`[${requestId}] Sent SIGTERM to child process`);
              
              // Set timeout for force kill
              return new Promise((resolve) => {
                const timeout = setTimeout(() => {
                  if (!child.killed) {
                    child.kill('SIGKILL');
                    console.log(`[${requestId}] Force killed child process with SIGKILL`);
                  }
                  resolve();
                }, 3000);
                
                // Clear timeout if process exits normally
                child.on('exit', () => {
                  clearTimeout(timeout);
                  console.log(`[${requestId}] Child process exited normally`);
                  resolve();
                });
              });
            } else {
              // For exec processes, just kill them
              child.kill();
              console.log(`[${requestId}] Killed exec child process`);
            }
          }
        } catch (err) {
          console.warn(`[${requestId}] Error killing child process:`, err.message);
        }
      });

      // Wait for all cleanup to complete
      await Promise.all(cleanupPromises);
      
      // Clear the array
      requests[requestId].childProcesses = [];
      
      // Set cancellation state
      requests[requestId].errorType = errorType;
      requests[requestId].status = 'cancelled';
      requests[requestId].error = errorMessage;
      requests[requestId].done = false;
      
      console.log(`[${requestId}] Pipeline cancelled and cleaned up`);
    }
  };

  // run background pipeline for this request
  (async () => {
    const cookiesScript = path.join(__dirname, 'GenerateAmazonCookie.js');
    const fetchScript = path.join(__dirname, 'fetchAlexaActivity.py');
    const syncScript = path.join(__dirname, 'SyncAudioTranscripts.py');
    // NEW: Audio download and report generation scripts
    const downloadAudioScript = path.join(__dirname, 'downloadAlexaAudio.py');
    const generateReportScript = path.join(__dirname, 'generateAudioReport.py');
    const hashScript = path.join(__dirname, 'hash.py');
    const jsonPath = path.join(__dirname, '..', 'matched_audio_transcripts.json');
    // NEW: html report path
    const htmlReportPath = path.join(__dirname, '..', 'smart_assistant_report.html');

    const env = { ...process.env, AMAZON_EMAIL: email, AMAZON_PASSWORD: password, REQUEST_ID: requestId };

    try {
      // Step 1: Generating cookies
      requests[requestId].step = 'cookies';
      requests[requestId].status = 'running';
      addLog('Establishing secure connection...', 10);

      // spawn node script (so we can capture exit and not block main thread)
      const child = spawn('node', [cookiesScript], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      
      // NEW: Track child process for potential cancellation
      requests[requestId].childProcesses.push(child);

      let cookieOutput = '';
      let cookieError = '';
      
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

        // In the cookie script stdout handler, add this condition:
        if (data.includes('OTP authentication completed successfully')) {
          // Clear any OTP error state since authentication succeeded
          requests[requestId].errorType = null;
          requests[requestId].otpError = null;
          requests[requestId].showOtpModal = false;
          addLog('OTP verification successful! Continuing data extraction...', 40);
        }

        // NEW: Detect authentication errors from the cookie script and CANCEL PIPELINE
        if (data.includes('INVALID_EMAIL')) {
          cancelPipeline('INVALID_EMAIL', 'Invalid email address provided');
          addLog('The email address is not associated with an Amazon account. Please check your email and try again.', null);
          return;
        }
        if (data.includes('INCORRECT_PASSWORD')) {
          cancelPipeline('INCORRECT_PASSWORD', 'Incorrect password provided');
          addLog('The password is incorrect. Please check your password and try again.', null);
          return;
        }
        if (data.includes('Push notification was denied')) {
          cancelPipeline('PUSH_DENIED', 'Push notification was denied');
          addLog('Sign in attempt was denied from your device. Please try again and approve the notification.', null);
          return;
        }
        // NEW: Detect unknown 2FA page
        if (data.includes('UNKNOWN_2FA_PAGE') || data.includes('Unknown 2FA page detected')) {
          cancelPipeline('UNKNOWN_2FA_PAGE', 'Unknown 2FA page detected');
          addLog('This account has been accessed too many times with this account. Please try again tomorrow.', null);
          return;
        }
        // NEW: Detect unexpected errors from the cookie script
        if (data.includes('UNEXPECTED_ERROR') || data.includes('An unexpected error occurred during authentication')) {
          cancelPipeline('GENERIC_ERROR', 'An unexpected error occurred during authentication. Please try again.');
          addLog('An unexpected error occurred during authentication. Please try again.', null);
          return;
        }
        // FIX: Only detect OTP verification failure if we're still in OTP context
        if ((data.includes('OTP verification failed') || data.includes('INVALID_OTP')) && 
            !data.includes('OTP authentication completed successfully')) {
          // For OTP failures, we don't cancel immediately - allow retry
          requests[requestId].errorType = 'INVALID_OTP';
          requests[requestId].status = 'waiting_for_2fa';
          requests[requestId].showOtpModal = true;
          requests[requestId].otpError = 'The code you entered is not valid. Please check the code and try again.';
          addLog('OTP verification failed. Please enter the correct code.', null);
        }
      });
      
      child.stderr.on('data', (d) => {
        const errorData = d.toString();
        cookieError += errorData;
        console.error(`[${requestId}] cookies stderr: ${errorData}`);
        
        // NEW: Also check stderr for authentication errors and CANCEL PIPELINE
        if (errorData.includes('INVALID_EMAIL')) {
          cancelPipeline('INVALID_EMAIL', 'Invalid email address provided');
          addLog('The email address is not associated with an Amazon account. Please check your email and try again.', null);
          return;
        }
        if (errorData.includes('INCORRECT_PASSWORD')) {
          cancelPipeline('INCORRECT_PASSWORD', 'Incorrect password provided');
          addLog('The password is incorrect. Please check your password and try again.', null);
          return;
        }
        if (errorData.includes('Push notification was denied')) {
          cancelPipeline('PUSH_DENIED', 'Push notification was denied');
          addLog('Sign in attempt was denied from your device. Please try again and approve the notification.', null);
          return;
        }
        // NEW: Detect unknown 2FA page
        if (errorData.includes('UNKNOWN_2FA_PAGE') || errorData.includes('Unknown 2FA page detected')) {
          cancelPipeline('UNKNOWN_2FA_PAGE', 'Unknown 2FA page detected');
          addLog('This account has been accessed too many times with this account. Please try again tomorrow.', null);
          return;
        }
        // NEW: Detect unexpected errors
        if (errorData.includes('UNEXPECTED_ERROR') || errorData.includes('An unexpected error occurred during authentication')) {
          cancelPipeline('GENERIC_ERROR', 'An unexpected error occurred during authentication. Please try again.');
          addLog('An unexpected error occurred during authentication. Please try again.', null);
          return;
        }
        // FIX: Only detect OTP verification failure if we're still in OTP context
        if ((errorData.includes('OTP verification failed') || errorData.includes('INVALID_OTP')) && 
            !errorData.includes('OTP authentication completed successfully')) {
          // For OTP failures, we don't cancel immediately - allow retry
          requests[requestId].errorType = 'INVALID_OTP';
          requests[requestId].status = 'waiting_for_2fa';
          requests[requestId].showOtpModal = true;
          requests[requestId].otpError = 'The code you entered is not valid. Please check the code and try again.';
          addLog('OTP verification failed. Please enter the correct code.', null);
        }
      });

      const exitCode = await new Promise((resolve) => child.on('close', resolve));
      
      // NEW: Remove child from tracking after it closes
      requests[requestId].childProcesses = requests[requestId].childProcesses.filter(cp => cp !== child);
      
      // NEW: Check if pipeline was cancelled due to authentication error
      if (requests[requestId].errorType && 
          ['INVALID_EMAIL', 'INCORRECT_PASSWORD', 'PUSH_DENIED', 'UNKNOWN_2FA_PAGE', 'CANCELLED'].includes(requests[requestId].errorType)) {
        console.log(`[${requestId}] Pipeline cancelled due to authentication error: ${requests[requestId].errorType}`);
        return; // Stop the pipeline completely
      }
      
      // NEW: Check for authentication errors after process completion
      if (requests[requestId].errorType === 'INVALID_EMAIL' || 
          requests[requestId].errorType === 'INCORRECT_PASSWORD' ||
          requests[requestId].errorType === 'PUSH_DENIED' ||
          requests[requestId].errorType === 'UNKNOWN_2FA_PAGE' ||
          requests[requestId].errorType === 'CANCELLED') {
        // Authentication error already handled above, just return early
        return;
      }
      
      if (exitCode !== 0 && !requests[requestId].errorType) {
        throw new Error(`GenerateAmazonCookie exited with ${exitCode}: ${cookieError}`);
      }
      
      // If we have an OTP error but the process is still running, continue
      if (requests[requestId].errorType === 'INVALID_OTP') {
        // Don't throw error, let the frontend handle OTP retry
        console.log(`[${requestId}] OTP verification failed, waiting for retry...`);
        return;
      }
      
      // Ensure we mark authentication as complete
      if (!requests[requestId].currentUrl?.includes('/alexa-privacy/apd/')) {
        updateCurrentUrl('https://www.amazon.in/alexa-privacy/apd/rvh');
      }
      addLog('Authentication completed successfully', 40);

      // Step 2: fetch Alexa activity - ONLY RUN IF AUTHENTICATION SUCCEEDED
      if (!requests[requestId].errorType) {
        requests[requestId].step = 'fetch';
        requests[requestId].status = 'running';
        addLog('Starting data extraction from your account... (this may take sometime) ', 45);

        let activityCount = 0;
        // In the fetch step, replace the custom object with the actual process:
        const fetchProcess = exec(`python "${fetchScript}"`, { env });

        // Track the actual process with a simple wrapper
        const fetchChild = {
          kill: () => {
            try {
              fetchProcess.kill();
              console.log(`[${requestId}] Killed fetch process`);
            } catch (err) {
              console.warn(`[${requestId}] Error killing fetch process:`, err.message);
            }
          }
        };
        requests[requestId].childProcesses.push(fetchChild);
        
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
            // Remove from tracking
            requests[requestId].childProcesses = requests[requestId].childProcesses.filter(cp => cp !== fetchChild);
            
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`fetchAlexaActivity exited with code ${code}`));
            }
          });
        });

        // Step 3: Sync transcripts - ONLY RUN IF PREVIOUS STEPS SUCCEEDED
        if (!requests[requestId].errorType) {
          requests[requestId].step = 'sync';
          addLog('Organizing extracted data...', 90);
          
          await new Promise((resolve, reject) => {
            exec(`python "${syncScript}"`, { env }, (err, stdout, stderr) => {
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
                  addLog(`Data organization complete (${mappingMatch[1]} entries processed)`, 92);
                }
              }
              resolve();
            });
          });

          // NEW: Step 4: Download audio files - ONLY RUN IF PREVIOUS STEPS SUCCEEDED
          if (!requests[requestId].errorType) {
            requests[requestId].step = 'download_audio';
            addLog('Initializing content for offline use...', 94);
            
            await new Promise((resolve, reject) => {
              exec(`python "${downloadAudioScript}"`, { env }, (err, stdout, stderr) => {
                if (err) {
                  console.warn(`[${requestId}] Audio download warning:`, err);
                  // Don't fail the pipeline if audio download has issues
                }
                console.log(`[${requestId}] Audio download output:`, stdout);
                if (stderr) console.error(`[${requestId}] Audio download stderr:`, stderr);
                
                // Parse download results
                if (stdout.includes('Download Summary')) {
                  const successMatch = stdout.match(/✅ Successful: (\d+)/);
                  const failedMatch = stdout.match(/❌ Failed: (\d+)/);
                  if (successMatch && failedMatch) {
                    addLog(`Audio download: ${successMatch[1]} successful, ${failedMatch[1]} failed`, 95);
                  }
                }
                resolve();
              });
            });

            // NEW: Step 5: Generate comprehensive report - ONLY RUN IF PREVIOUS STEPS SUCCEEDED
            if (!requests[requestId].errorType) {
              requests[requestId].step = 'generate_report';
              addLog('Generating comprehensive HTML report with embedded audio...', 97);
              
              await new Promise((resolve, reject) => {
                exec(`python "${generateReportScript}"`, { env }, (err, stdout, stderr) => {
                  if (err) {
                    console.error(`[${requestId}] Report generation error:`, err);
                    return reject(err);
                  }
                  console.log(`[${requestId}] Report generation output:`, stdout);
                  if (stderr) console.error(`[${requestId}] Report generation stderr:`, stderr);
                  
                  // NEW: Check for audio cleanup completion
                  if (stdout.includes('Temporary audio files have been cleaned up')) {
                    addLog('Audio files cleaned up to save storage space', 98);
                  }
                  
                  if (stdout.includes('HTML REPORT GENERATION COMPLETE')) {
                    addLog('Comprehensive HTML report generated with embedded audio!', 99);
                  }
                  resolve();
                });
              });

              // NEW: Step 6: hash and prepare final report for download - ONLY RUN IF PREVIOUS STEPS SUCCEEDED
              if (!requests[requestId].errorType) {
                requests[requestId].step = 'hash';
                addLog('Finalizing report package...', 99);
                
                await new Promise((resolve, reject) => {
                  exec(`python "${hashScript}" "${htmlReportPath}"`, { env }, (err, stdout, stderr) => {
                    if (err) {
                      console.warn(`[${requestId}] hash error:`, err);
                      // Don't reject here as hash failure shouldn't stop the download
                    }
                    console.log(`[${requestId}] hash output:`, stdout);
                    resolve();
                  });
                });

                requests[requestId].step = 'completed';
                // NEW: Set filePath to the html report instead of HTML
                requests[requestId].filePath = htmlReportPath;
                requests[requestId].done = true;
                requests[requestId].status = 'completed';
                addLog('Data extraction complete! Your comprehensive HTML report with embedded audio is ready for download.', 100);
                
                console.log(`[${requestId}] Pipeline completed successfully with embedded audio report.`);
              }
            }
          }
        }
      }
    } catch (err) {
      console.error(`[${requestId}] Pipeline error:`, err.message || err);
      
      // Don't override specific error types that were already set
      if (!requests[requestId].errorType) {
        requests[requestId].status = 'error';
        
        // Convert technical errors to user-friendly messages
        let userFriendlyMessage = 'An unexpected error occurred. Please try again.';
        
        if (err.message.includes('push notification') || err.message.includes('Push')) {
          userFriendlyMessage = 'Push notification was not approved in time. Please try again and make sure to approve the notification on your device.';
        } else if (err.message.includes('2FA') || err.message.includes('authentication')) {
          userFriendlyMessage = 'Authentication failed. Please check your credentials and try again.';
        } else if (err.message.includes('credentials') || err.message.includes('password') || err.message.includes('email')) {
          userFriendlyMessage = 'Invalid email or password. Please check your credentials and try again.';
        } else if (err.message.includes('timeout') || err.message.includes('timed out')) {
          userFriendlyMessage = 'The request timed out. Please try again.';
        } else if (err.message.includes('network') || err.message.includes('connection')) {
          userFriendlyMessage = 'Network connection error. Please check your internet connection and try again.';
        } else if (err.message.includes('UNEXPECTED_ERROR')) {
          userFriendlyMessage = 'An unexpected error occurred during authentication. Please try again.';
        }
        
        requests[requestId].error = userFriendlyMessage;
        requests[requestId].errorType = 'GENERIC_ERROR';
        
        addLog(userFriendlyMessage, null);
      }
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
  info.otpError = null; // Clear any previous OTP errors
  info.showOtpModal = false; // NEW: Immediately hide OTP modal after submission
  console.log(`[${id}] OTP received from frontend (masked): ${otp ? otp.replace(/\d/g,'*') : ''}`);
  res.json({ ok: true });
});

// NEW: Clear OTP for retry
app.post('/api/internal/clear-otp/:id', (req, res) => {
  const id = req.params.id;
  const info = requests[id];
  if (!info) return res.status(404).send('Not found');
  info.otp = null;
  info.otpError = null;
  console.log(`[${id}] OTP cleared for retry`);
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

// NEW: Endpoint to cancel pipeline execution
app.post('/api/cancel-acquisition/:id', async (req, res) => {
  const id = req.params.id;
  const info = requests[id];
  if (!info) return res.status(404).send('Not found');

  console.log(`[${id}] User requested cancellation of pipeline`);

  // NEW: Enhanced cancelPipeline function to handle user cancellation
  const cancelPipeline = async (requestId, errorType, errorMessage) => { // CHANGED: Add requestId parameter
    if (requests[requestId]) {
      console.log(`[${requestId}] Cancelling pipeline due to: ${errorType}`);
      
      // Add cancellation log
      if (requests[requestId].logs) {
        requests[requestId].logs.push({
          timestamp: new Date().toISOString(),
          message: 'Data acquisition cancelled by user. Cleaning up...'
        });
      }
      
      // Kill all child processes - handle both spawn and exec processes
      const cleanupPromises = requests[requestId].childProcesses.map(async (child) => {
        try {
          // For spawn processes (actual ChildProcess objects)
          if (child && typeof child.kill === 'function' && child.pid) {
            console.log(`[${requestId}] Terminating spawn process (PID: ${child.pid})...`);
            child.kill('SIGTERM');
            
            // Wait for process to exit with timeout
            return new Promise((resolve) => {
              const timeout = setTimeout(() => {
                if (child.exitCode === null) {
                  child.kill('SIGKILL');
                  console.log(`[${requestId}] Force killed spawn process with SIGKILL`);
                }
                resolve();
              }, 3000);
              
              // Clear timeout if process exits normally
              child.on('exit', () => {
                clearTimeout(timeout);
                console.log(`[${requestId}] Spawn process exited normally`);
                resolve();
              });
            });
          } 
          // For exec processes (custom objects with kill method)
          else if (child && typeof child.kill === 'function') {
            console.log(`[${requestId}] Killing exec process...`);
            child.kill();
            console.log(`[${requestId}] Exec process killed`);
            return Promise.resolve();
          } 
          // For any other type, just log and continue
          else {
            console.warn(`[${requestId}] Unknown child process type:`, typeof child);
            return Promise.resolve();
          }
        } catch (err) {
          console.warn(`[${requestId}] Error killing child process:`, err.message);
          return Promise.resolve();
        }
      });

      // Wait for all cleanup to complete
      await Promise.all(cleanupPromises);
      
      // Clear the array
      requests[requestId].childProcesses = [];
      
      // Set cancellation state
      requests[requestId].errorType = errorType;
      requests[requestId].status = 'cancelled';
      requests[requestId].error = errorMessage;
      requests[requestId].done = false;
      
      console.log(`[${requestId}] Pipeline cancelled and cleaned up`);
    }
  };

  // Cancel the pipeline - pass the id as parameter
  await cancelPipeline(id, 'CANCELLED', 'Data acquisition was cancelled by user.');

  res.json({ ok: true, message: 'Pipeline cancelled successfully' });
});

// Internal endpoint used by the headless node script to set detected method / message
app.post('/api/internal/2fa-update/:id', (req, res) => {
  const id = req.params.id;
  const { method, message, currentUrl, errorType, otpError, showOtpModal } = req.body;
  const info = requests[id];
  if (!info) return res.status(404).send('Not found');
  
  // FIX: Only update method if it's provided and not null/undefined
  if (method !== undefined && method !== null) {
    info.method = method;
  }
  
  info.message = message || null;
  info.status = 'waiting_for_2fa';
  
  // NEW: Handle OTP modal display and errors
  if (errorType === 'INVALID_OTP') {
    info.errorType = errorType;
    info.showOtpModal = showOtpModal !== undefined ? showOtpModal : true; // NEW: Reopen OTP modal for invalid OTP
    info.otpError = otpError || 'The code you entered is not valid. Please check the code and try again.';
    // FIX: Ensure method is set to OTP when we have invalid OTP
    if (!info.method || !info.method.includes('OTP')) {
      info.method = 'OTP (SMS/Voice)';
    }
  } else if (errorType === 'PUSH_DENIED') {
    info.errorType = errorType;
    info.status = 'error';
    info.error = message || 'Push notification was denied';
    info.showOtpModal = false; // Ensure OTP modal is closed
  } else if (errorType === 'UNKNOWN_2FA_PAGE') {
    info.errorType = errorType;
    info.status = 'error';
    info.error = message || 'Unknown 2FA page detected';
    info.showOtpModal = false; // Ensure OTP modal is closed
  } else {
    info.showOtpModal = showOtpModal !== undefined ? showOtpModal : (method && method.includes('OTP'));
    info.otpError = null;
  }
  
  if (currentUrl) {
    info.currentUrl = currentUrl;
  }
  console.log(`[${id}] 2FA update from script:`, method, message, currentUrl, errorType, showOtpModal);
  res.json({ ok: true });
});

// Internal endpoint used by headless script to poll for OTP (if frontend submitted)
app.get('/api/internal/get-otp/:id', (req, res) => {
  const id = req.params.id;
  const info = requests[id];
  if (!info) return res.status(404).send('Not found');
  res.json({ 
    otp: info.otp || null, 
    userConfirmed2FA: !!info.userConfirmed2FA,
    showOtpModal: !!info.showOtpModal,
    otpError: info.otpError || null
  });
});

// Download endpoint once pipeline is complete - FIXED FOR MULTIPLE DOWNLOADS
app.get('/api/download/:id', (req, res) => {
  const id = req.params.id;
  const info = requests[id];
  if (!info) return res.status(404).send('Not found');
  if (!info.done) return res.status(400).send('Not ready');
  let filePath = info.filePath; // Use let because we might change it in fallback
  
  // DEBUG: Log what file path we're trying to serve
  console.log(`[${id}] Download requested, filePath: ${filePath}`);
  
  if (!filePath || !fs.existsSync(filePath)) {
    console.log(`[${id}] File not found at path: ${filePath}`);
    
    // FALLBACK: Check if HTML report exists even if filePath wasn't set correctly
    const htmlReportPath = path.join(__dirname, '..', 'smart_assistant_report.html');
    if (fs.existsSync(htmlReportPath)) {
      console.log(`[${id}] Serving fallback HTML report`);
      filePath = htmlReportPath;
    } else {
      return res.status(500).send('File not found');
    }
  }
  
  // Determine file type and set appropriate headers
  if (filePath.endsWith('.html')) {
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', 'attachment; filename="smart_assistant_report.html"');
    console.log(`[${id}] Serving HTML report: ${filePath}`);
  } else if (filePath.endsWith('.json')) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="alexa_data.json"');
    console.log(`[${id}] Serving JSON data: ${filePath}`);
  } else {
    // Default to download with original filename
    const filename = path.basename(filePath);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  }
  
  res.sendFile(filePath, (err) => {
    if (err) {
      console.error(`[${id}] Error sending file:`, err);
      return res.status(500).send('Error sending file');
    }
    
    // NOTE: We don't delete the HTML file here anymore - it will be cleaned up when a new pipeline starts
    console.log(`[${id}] File sent successfully`);
    
    // FIXED: Do NOT clean up the request from memory so multiple downloads work
    // The request will be cleaned up when the user goes back to acquisition or starts a new one
  });
});

const PORT = 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));