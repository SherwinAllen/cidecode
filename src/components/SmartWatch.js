import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { MatrixBackground } from './Layout';
import { motion } from 'framer-motion';
import { 
  containerStyle,
  pageContentStyle,
  fancyHeadingStyle,
  spinnerStyle
} from '../constants/styles';

const SmartWatch = () => {
  const [loading, setLoading] = useState(true);
  const [teamText, setTeamText] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState(null);
  const [artifacts, setArtifacts] = useState({});
  const [selectedArtifact, setSelectedArtifact] = useState(null);
  const [artifactText, setArtifactText] = useState('');
  const [statusMessage, setStatusMessage] = useState('');

  const navigate = useNavigate();

  // const teamInfo = "Team Name: paidRTOS\nTeam Members:\n\t1. Shambo Sarkar\n\t2. Sathvik S\n\t3. Sherwin Allen\n\t4. Meeran Ahmed";

  // // Typing animation for team info
  // useEffect(() => {
  //   let currentIndex = 0;
  //   const typingInterval = setInterval(() => {
  //     setTeamText(teamInfo.slice(0, currentIndex + 1));
  //     currentIndex++;
  //     if (currentIndex >= teamInfo.length) clearInterval(typingInterval);
  //   }, 100);
  //   return () => clearInterval(typingInterval);
  // }, []);

  // Simulate loading
  useEffect(() => {
    const timer = setTimeout(() => setLoading(false), 3000);
    return () => clearTimeout(timer);
  }, []);

  // Function to acquire data from backend
  const handleAcquireData = async () => {
    setDownloading(true);
    setError(null);
    setArtifacts({});
    setSelectedArtifact(null);
    setArtifactText('');
    try {
      const queryParams = new URLSearchParams({ source: 'SmartWatch' });
      const response = await fetch(`http://localhost:5000/api/packet-report?${queryParams.toString()}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch data: ${response.statusText}`);
      }
      
      const data = await response.json();

      console.log("Data is:",data)
      if (!data.success) throw new Error('Acquisition failed');
      setArtifacts(data.artifacts || {});
      setStatusMessage(data.message || "Preliminary forensic summary generated and downloaded successfully!");
      setTimeout(() => setStatusMessage(""), 4000);

    } catch (err) {
      console.error("Error acquiring data:", err);
      setError(err.message);
    } finally {
      setDownloading(false);
    }
  };

  // Button style (neon theme)
  const bigButtonStyle = {
    width: '80%',
    padding: '20px',
    backgroundColor: '#0f0', // neon green
    border: 'none',
    color: '#000',
    cursor: 'pointer',
    fontSize: '1.5rem',
    borderRadius: '10px',
    margin: '20px auto',
    display: 'block',
    fontFamily: "'Orbitron', sans-serif",
    textTransform: 'uppercase',
    boxShadow: '0 0 20px rgba(0,255,0,0.7)',
    transition: 'transform 0.2s ease-in-out, box-shadow 0.2s ease-in-out'
  };

  const bigButtonHover = {
    scale: 1.1,
    boxShadow: '0 0 30px rgba(0,255,0,1)'
  };

      const handleDownloadArtifact = async (artifactName) => {
        try {
          console.log(artifactName)
          const response = await fetch(`http://localhost:3000/artifact/download/${artifactName}`);
          if (!response.ok) throw new Error('Failed to download file.');

          // Convert response to blob and trigger download
          const blob = await response.blob();
          const url = window.URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = artifactName; 
          document.body.appendChild(a);
          a.click();
          a.remove();
          window.URL.revokeObjectURL(url);

          console.log(`✅ ${artifactName} downloaded successfully!`);
        } catch (err) {
          console.error('Error downloading artifact:', err);
          alert(`Error downloading ${artifactName}: ${err.message}`);
        }
      };

return (
  <div
    style={{
      ...containerStyle,
      height: 'auto',            // allow natural content height
      minHeight: '100vh',        // at least one viewport tall
      overflowY: 'auto',         // enable vertical scroll
      overflowX: 'hidden',       // optional: disable horizontal scroll
    }}
  >


    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      style={{
        ...pageContentStyle,
        paddingBottom: '80px',   // space at the bottom for long scroll
      }}
    >
      <h1 style={{ ...fancyHeadingStyle, fontSize: '2.5rem', marginBottom: '48px' }}>
        SMART WATCH DATA
      </h1>

      {error && (
        <p style={{ color: 'red', fontSize: '1.2rem', textAlign: 'center' }}>{error}</p>
      )}

      <motion.button
        onClick={handleAcquireData}
        style={bigButtonStyle}
        whileHover={bigButtonHover}
        disabled={downloading}
      >
        {downloading ? 'Acquiring Data...' : 'Acquire Data'}
      </motion.button>

      <motion.button
        onClick={() => navigate('/iotextractor')}
        style={bigButtonStyle}
        whileHover={bigButtonHover}
      >
        Back to Devices
      </motion.button>

      {statusMessage && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          style={{
            backgroundColor: 'rgba(0, 255, 0, 0.1)',
            border: '1px solid #0f0',
            color: 'rgba(76, 145, 231, 1)',
            padding: '15px 20px',
            borderRadius: '8px',
            fontFamily: "'Orbitron', sans-serif",
            textAlign: 'center',
            marginBottom: '25px',
            boxShadow: '0 0 15px rgba(0,255,0,0.6)',
            width: '80%',
            marginLeft: 'auto',
            marginRight: 'auto',
          }}
        >
          {statusMessage}
        </motion.div>
      )}

      {/* Artifact section */}
      {Object.keys(artifacts).length > 0 && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',             // handles overflow gracefully
            marginTop: '30px',
            padding: '0 20px',
          }}
        >
          {/* LEFT SIDE: Button list + download */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              width: '25%',
              gap: '10px',
              overflowY: 'auto',          // independent scroll if list is long
              maxHeight: '70vh',
            }}
          >
            <h2 style={{ color: '#0f0', marginBottom: '10px' }}>Extracted Artifacts</h2>

            {Object.keys(artifacts).map((key) => (
              <div
                key={key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  width: '100%',
                  gap: '10px',
                }}
              >
                <motion.button
                  onClick={() => {
                    if (selectedArtifact === key) {
                      setSelectedArtifact(null);
                      setArtifactText('');
                    } else {
                      setSelectedArtifact(key);
                      setArtifactText(artifacts[key]);
                    }
                  }}
                  style={{
                    flex: 1,
                    padding: '8px 12px',
                    backgroundColor: selectedArtifact === key ? '#0f0' : 'transparent',
                    border: '1px solid #0f0',
                    borderRadius: '5px',
                    cursor: 'pointer',
                    fontSize: '0.9rem',
                    fontFamily: "'Orbitron', sans-serif",
                    color: selectedArtifact === key ? '#000' : '#0f0',
                    textAlign: 'left',
                    transition: 'all 0.2s ease-in-out',
                  }}
                  whileHover={{
                    scale: 1.05,
                    boxShadow: '0 0 15px rgba(0,255,0,1)',
                  }}
                >
                  {key.replace(/_/g, ' ')}
                </motion.button>

                {selectedArtifact !== key && (
                  <motion.button
                    onClick={() => handleDownloadArtifact(key)}
                    style={{
                      padding: '6px 10px',
                      backgroundColor: '#0f0',
                      color: '#000',
                      border: 'none',
                      borderRadius: '5px',
                      cursor: 'pointer',
                      fontSize: '0.8rem',
                      fontFamily: "'Orbitron', sans-serif",
                      boxShadow: '0 0 10px rgba(0,255,0,0.5)',
                    }}
                    whileHover={{
                      scale: 1.05,
                      boxShadow: '0 0 15px rgba(0,255,0,1)',
                    }}
                  >
                    ⬇ Download
                  </motion.button>
                )}
              </div>
            ))}
          </div>

          {/* RIGHT SIDE: Text display */}
          <div
            style={{
              flex: 1,
              marginLeft: '30px',
              background: 'rgba(0, 255, 0, 0.05)',
              border: '1px solid #0f0',
              borderRadius: '10px',
              padding: '20px',
              color: 'rgba(255, 255, 255, 1)',
              whiteSpace: 'pre-wrap',
              minHeight: '400px',
              maxHeight: '70vh',
              overflowY: 'auto',
            }}
          >
            {selectedArtifact ? (
              <>
                <h3
                  style={{
                    fontFamily: "'Orbitron', sans-serif",
                    color: '#0f0',
                    marginBottom: '10px',
                  }}
                >
                  {selectedArtifact.replace(/_/g, ' ')}
                </h3>
                <p style={{ fontFamily: 'monospace', fontSize: '0.9rem' }}>
                  {artifactText}
                </p>
              </>
            ) : (
              <p style={{ color: '#0f0', opacity: 0.7 }}>
                Select an artifact to view its contents.
              </p>
            )}
          </div>
        </div>
      )}
    </motion.div>
  </div>
)};

export default SmartWatch; 
