
import Wall from "./Wall";
import { HashRouter, Routes, Route } from "react-router-dom";

function App() {
  return (
    <HashRouter basename="/character-scan">
      <Routes>
        <Route path="/" element={<KioskApp />} />
        <Route path="/wall" element={<Wall />} />
      </Routes>
    </HashRouter>
  );
}

export default App;