require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');

const app = express();

connectDB();

app.use(cors());
app.use(express.json());

app.use('/api/auth',         require('./routes/auth'));
app.use('/api/rooms',        require('./routes/rooms'));
app.use('/api/tables',       require('./routes/tables'));
app.use('/api/customers',    require('./routes/customers'));
app.use('/api/reservations', require('./routes/reservations'));
app.use('/api/shifts',       require('./routes/shifts'));
app.use('/api/vacations',    require('./routes/vacations'));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
