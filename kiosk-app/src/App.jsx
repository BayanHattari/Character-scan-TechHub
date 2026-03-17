import { BrowserRouter, Routes, Route } from "react-router-dom";
import KioskApp from "./KioskApp";
import Wall from "./Wall";

function App() {
  return (
    <BrowserRouter basename="/character-scan">
      <Routes>
        <Route path="/" element={<KioskApp />} />
        <Route path="/wall" element={<Wall />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;