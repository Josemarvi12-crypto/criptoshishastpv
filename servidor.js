const express = require('express');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 5000;

// Servir archivos estáticos
app.use(express.static(path.join(__dirname)));

// Ruta raíz
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Iniciar servidor
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor ejecutándose en http://localhost:${PORT}`);
});
