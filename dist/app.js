import express from 'express';
import mysql from 'mysql2/promise';
import { createClient } from 'redis';
import dotenv from 'dotenv';
import cron from 'node-cron';
dotenv.config();
const router = express.Router();
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
// Add Earnings to Leaderboard and Prize Pool
router.post('/leaderboard/earn', async (req, res) => {
    try {
        const { playerId, amount } = req.body;
        if (!playerId || typeof amount !== 'number') {
            return res.status(400).json({ error: 'Invalid playerId or amount' });
        }
        await redisClient.zIncrBy(LEADERBOARD_KEY, amount, playerId.toString());
        await redisClient.incrByFloat(PRIZE_POOL_KEY, amount * 0.02);
        return res.json({ message: 'Earnings updated successfully' });
    }
    catch (error) {
        console.error('Error updating earnings:', error);
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
                    reward = prizePool * rewards[i];
                }
                else {
                    reward = remainingPrize * 0.00567; // Distribute remaining among top 100
                }
                remainingPrize -= reward;
                await db.query('UPDATE players SET money = money + ? WHERE id = ?', [reward, leaderboard[i].value]);
            }
        }
        await redisClient.del(LEADERBOARD_KEY);
        await redisClient.set(PRIZE_POOL_KEY, '0');
        console.log('Leaderboard reset and prizes distributed successfully');
    }
    catch (error) {
        console.error('Error during scheduled leaderboard reset:', error);
    }
});
// Get Top 100 Leaderboard
router.get('/leaderboard/top100', async (req, res) => {
    try {
        const leaderboard = await redisClient.zRangeWithScores(LEADERBOARD_KEY, 0, 99, { REV: true });
        res.json(leaderboard);
    }
    catch (error) {
        console.error('Error fetching top 100 leaderboard:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
// Get Grouped Leaderboard
router.get('/leaderboard/grouped', async (req, res) => {
    try {
        const leaderboard = await redisClient.zRangeWithScores(LEADERBOARD_KEY, 0, 99, { REV: true });
        res.json(leaderboard);
    }
    catch (error) {
        console.error('Error fetching grouped leaderboard:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
// Search Player in Leaderboard
router.get('/leaderboard/search', async (req, res) => {
    try {
        const { query } = req.query;
        if (!query)
            return res.status(400).json({ error: 'Query parameter is required' });
        const [players] = await db.query(`SELECT id, name, country, country_code FROM players 
             WHERE name LIKE ? OR country LIKE ?`, [`%${query}%`, `%${query}%`]);
        if (!players.length)
            return res.json([]);
        const result = await Promise.all(players.map(async (player) => {
            const rank = await redisClient.zRevRank(LEADERBOARD_KEY, player.id.toString());
            const score = await redisClient.zScore(LEADERBOARD_KEY, player.id.toString());
            return {
                ranking: rank !== null ? rank + 1 : null,
                playerName: player.name,
                country: player.country,
                countryCode: player.country_code,
                money: score ? Number(score) : 0
            };
        }));
        return res.json(result);
    }
    catch (error) {
        console.error('Error searching leaderboard:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});
export default router;
