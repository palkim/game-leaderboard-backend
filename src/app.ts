import express, { Request, Response } from 'express';
import mysql from 'mysql2/promise';
import { createClient } from 'redis';
import dotenv from 'dotenv';
import cron from 'node-cron';
import cors from 'cors';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
const LEADERBOARD_KEY = 'game_leaderboard';
const PRIZE_POOL_KEY = 'leaderboard_prize_pool';

// MySQL Connection
const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
});

// Redis Connection
const redisClient = createClient({ url: process.env.REDIS_URL });
await redisClient.connect();

// Use CORS middleware before defining routes
app.use(cors({
    origin: 'http://localhost:3000', // Allow requests from this origin
    credentials: true // Allow credentials to be sent
}));

app.use(express.json());

// Add Earnings to Leaderboard and Prize Pool
app.post('/leaderboard/earn', async (req: Request, res: Response) => {
    try {
        const { playerId, amount } = req.body;
        if (!playerId || typeof amount !== 'number') {
            return res.status(400).json({ error: 'Invalid playerId or amount' });
        }
        
        // Check if player exists in MySQL
        const [players] = await db.query<mysql.RowDataPacket[]>(
            'SELECT id FROM players WHERE id = ?',
            [playerId]
        );
        
        if (players.length === 0) {
            return res.status(404).json({ error: 'Player not found' });
        }
        
        await redisClient.zIncrBy(LEADERBOARD_KEY, amount, playerId.toString());
        await redisClient.incrByFloat(PRIZE_POOL_KEY, amount * 0.02);
        return res.json({ message: 'Earnings updated successfully' });
    } catch (error) {
        console.error('Error updating earnings:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Create a new player in MySQL and add to Redis with 0 earnings
app.post('/player/create', async (req: Request, res: Response) => {
    try {
        const { name, country, countryCode } = req.body;
        if (!name || !country || !countryCode) {
            return res.status(400).json({ error: 'Missing required player details' });
        }

        // Check if player exists in MySQL
        const [existingPlayers] = await db.query<mysql.RowDataPacket[]>(
            'SELECT id FROM players WHERE name = ? AND country = ? AND country_code = ?',
            [name, country, countryCode]
        );

        if (existingPlayers.length > 0) {
            return res.status(409).json({ error: 'Player already exists' });
        }

        // Insert player into MySQL
        const [result] = await db.query(
            'INSERT INTO players (name, country, country_code) VALUES (?, ?, ?)',
            [name, country, countryCode]
        );
        
        const playerId = (result as mysql.ResultSetHeader).insertId;

        // Initialize earnings in Redis
        await redisClient.zAdd(LEADERBOARD_KEY, [{ score: 0, value: playerId.toString() }]);
        
        return res.json({ message: 'Player created successfully', playerId });
    } catch (error) {
        console.error('Error creating player:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Schedule leaderboard reset every Sunday at 23:59
cron.schedule('59 23 * * 0', async () => {
    console.log('Running scheduled leaderboard reset...');
    try {
        const prizePool = parseFloat(await redisClient.get(PRIZE_POOL_KEY) || '0');
        const leaderboard = await redisClient.zRangeWithScores(LEADERBOARD_KEY, 0, 99, { REV: true });

        if (leaderboard.length > 0) {
            const rewards = [0.2, 0.15, 0.1];
            let remainingPrize = prizePool;

            for (let i = 0; i < leaderboard.length; i++) {
                let reward = 0;
                if (i < 3) {
                    reward = prizePool * rewards[i]; // Top 3 players get fixed percentages
                } else {
                    reward = remainingPrize * 0.00567; // Distribute remaining among top 100
                }
                remainingPrize -= reward;

                await redisClient.zIncrBy(LEADERBOARD_KEY, reward, leaderboard[i].value);
            }
        }

        await redisClient.set(PRIZE_POOL_KEY, '0'); // Reset the prize pool

        console.log('✅ Leaderboard reset and prizes distributed successfully');
    } catch (error) {
        console.error('❌ Error during scheduled leaderboard reset:', error);
    }
});


// Get Top 100 Leaderboard
app.get('/leaderboard/top100', async (req: Request, res: Response) => {
    try {
        const leaderboard = await redisClient.zRangeWithScores(LEADERBOARD_KEY, 0, 99, { REV: true });
        
        // Fetch player details from MySQL for each player in the leaderboard
        const playerIds = leaderboard.map(player => player.value);
        const [players] = await db.query<mysql.RowDataPacket[]>(
            `SELECT id, name, country, country_code FROM players WHERE id IN (?)`,
            [playerIds]
        );

        // Map the leaderboard data to include player details and ranking
        const result = leaderboard.map((player, index) => {
            const playerDetails = players.find(p => p.id.toString() === player.value);
            return {
                ranking: index + 1,
                id: player.value,
                playerName: playerDetails ? playerDetails.name : null,
                country: playerDetails ? playerDetails.country : null,
                countryCode: playerDetails ? playerDetails.country_code : null,
                money: player.score
            };
        });

        res.json(result);
    } catch (error) {
        console.error('Error fetching top 100 leaderboard:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Search Player in Leaderboard
app.get('/leaderboard/search', async (req: Request, res: Response) => {
    try {
        const { query } = req.query;
        if (!query) return res.status(400).json({ error: 'Query parameter is required' });
        
        const [players] = await db.query<mysql.RowDataPacket[]>(
            `SELECT id, name, country, country_code FROM players 
             WHERE name LIKE ? OR country LIKE ?`,
            [`%${query}%`, `%${query}%`]
        );
        
        if (!players.length) return res.json([]);
        
        const result = await Promise.all(
            players.map(async (player) => {
                const rank = await redisClient.zRevRank(LEADERBOARD_KEY, player.id.toString());
                const score = await redisClient.zScore(LEADERBOARD_KEY, player.id.toString());
                return {
                    ranking: rank !== null ? rank + 1 : null,
                    playerName: player.name,
                    country: player.country,
                    countryCode: player.country_code,
                    money: score ? Number(score) : 0
                };
            })
        );
        
        return res.json(result);
    } catch (error) {
        console.error('Error searching leaderboard:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
