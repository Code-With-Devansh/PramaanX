import express from 'express';
import authRouter from "./routes/auth.route.js"
import cookieParser from 'cookie-parser';
import cors from 'cors'

import { errorHandler } from "./middlewares/error.js";


const app = express();
const port = 3000;
app.use(cors({
    origin: "http://localhost:5173", // React/Vite app
    credentials: true,
  }))
app.use(express.json());
app.use(cookieParser());


app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.use("/api/v1", authRouter);




// Error handler must be registered last so it catches errors from every route
// above (Express 5 forwards rejected async handlers here automatically).
app.use(errorHandler);

