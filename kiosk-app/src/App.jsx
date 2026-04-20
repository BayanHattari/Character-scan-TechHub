import KioskApp from "./KioskApp";
import Wall from "./Wall";
import { HashRouter, Routes, Route } from "react-router-dom";

function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<KioskApp />} />
        <Route path="/wall" element={<Wall />} />
      </Routes>
    </HashRouter>
  );
}

export default App;