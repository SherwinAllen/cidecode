// App.js
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import IoTExtractor from './components/IoTExtractor';
import DevicePage from './components/DevicePage';
import LoginPage from './components/LoginPage'
import CaseInfo from './components/CaseInformation'
import FileSystem from './components/FileSystem'
import SmartWatch from './components/SmartWatch';

const App = () => (
  <Router>
    <Routes>
      <Route path="/" element={<LoginPage />} />
      <Route path="/caseinfo" element={<CaseInfo />} />
      <Route path="/iotextractor" element={<IoTExtractor />} />
      <Route path="/:deviceName" element={<DevicePage />} />
      <Route path="/filesystem" element={<FileSystem/>}/>
      <Route path="/smartwatch" element={<SmartWatch/>}/>
    </Routes>
  </Router>
);

export default App;