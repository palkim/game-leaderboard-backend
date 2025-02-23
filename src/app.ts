import express, { Request, Response } from "express";
import mysql from "mysql2/promise";
import { createClient } from "redis";
import dotenv from "dotenv";
import cron from "node-cron";
import cors from "cors";
import winston from 'winston'; // Winston kütüphanesini içe aktar

dotenv.config();

const app = express();
const PORT = process.env.PORT ?? 4000;
const LEADERBOARD_KEY = "game_leaderboard";
const PRIZE_POOL_KEY = "leaderboard_prize_pool";

// MySQL Connection
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Redis Connection
const redisClient = createClient({ url: process.env.REDIS_URL });
await redisClient.connect();

// Use CORS middleware before defining routes
app.use(
  cors({
    origin: "http://localhost:3000", // Allow requests from this origin
    credentials: true, // Allow credentials to be sent
  })
);

app.use(express.json());

const logger = winston.createLogger({
  level: 'error',
  format: winston.format.json(),
  transports: [
      new winston.transports.File({ filename: 'error.log' }),
  ],
});

// Add Earnings to Leaderboard and Prize Pool
app.post("/leaderboard/earn", async (req: Request, res: Response) => {
  try {
    const { playerId, amount } = req.body;
    if (!playerId || typeof amount !== "number") {
      return res.status(400).json({ error: "Invalid playerId or amount" });
    }

    // Check if player exists in MySQL
    const [players] = await db.query<mysql.RowDataPacket[]>(
      "SELECT id FROM players WHERE id = ?",
      [playerId]
    );

    if (players.length === 0) {
      return res.status(404).json({ error: "Player not found" });
    }

    await redisClient.zIncrBy(LEADERBOARD_KEY, amount, playerId.toString());
    await redisClient.incrByFloat(PRIZE_POOL_KEY, amount * 0.02);
    return res.json({ message: "Earnings updated successfully" });
  } catch (error: any) {
    console.error("Error updating earnings:", error);
    logger.error(`Error message: ${(error)?.message || "Unknown error"}, Error stack: ${(error)?.stack || "No stack trace"}`);
    
    return res.status(500).json({
      error: "Internal Server Error",
      message: `Error updating earnings: ${(error)?.message || "Unknown error"}`
  });
  }
});

// Create a new player in MySQL and add to Redis with 0 earnings
app.post("/player/create", async (req: Request, res: Response) => {
  try {
    const { name, country, countryCode } = req.body;
    if(!name?.trim() || !country?.trim() || !countryCode?.trim()) {
      return res.status(400).json({ error: "Missing required player details" });
    }

    // Check if player exists in MySQL
    const [existingPlayers] = await db.query<mysql.RowDataPacket[]>(
      "SELECT id FROM players WHERE name = ? AND country = ? AND country_code = ?",
      [name, country, countryCode]
    );

    if (existingPlayers.length > 0) {
      return res.status(409).json({ error: "Player already exists" });
    }

    // Insert player into MySQL
    const [result] = await db.query(
      "INSERT INTO players (name, country, country_code) VALUES (?, ?, ?)",
      [name, country, countryCode]
    );

    const playerId = (result as any).insertId;

    // Initialize earnings in Redis
    await redisClient.zAdd(LEADERBOARD_KEY, [
      { score: 0, value: playerId.toString() },
    ]);

    return res.status(201).json({ message: "Player created successfully", playerId });
  } catch (error: any) {
    console.error("Error creating player: ", error);
    logger.error(`Error message: ${error?.message || "Unknown error"}, Error stack: ${error?.stack || "No stack trace"}`);

    return res.status(500).json({
      error: "Internal Server Error",
      message: `Error creating player: ${error?.message || "Unknown error"}`
    });
  }
});

// Schedule leaderboard reset every Sunday at 23:59
cron.schedule("59 23 * * 0", async () => {
  console.log("Running scheduled leaderboard reset...");
  try {
    const prizePool = parseFloat(
      (await redisClient.get(PRIZE_POOL_KEY)) || "0"
    );
    const leaderboard = await redisClient.zRangeWithScores(
      LEADERBOARD_KEY,
      0,
      99,
      { REV: true }
    );

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

        await redisClient.zIncrBy(
          LEADERBOARD_KEY,
          reward,
          leaderboard[i].value
        );
      }
    }

    await redisClient.set(PRIZE_POOL_KEY, "0"); // Reset the prize pool

    console.log("Prize pool reset and prizes distributed successfully");
  } catch (error: any) {
    console.error("Error during scheduled leaderboard reset: ", error);
    logger.error(`Error message: ${error?.message || "Unknown error"}, Error stack: ${error?.stack || "No stack trace"}`);
  }
});

async function getTopRankingPlayers() {
  const leaderboard = await redisClient.zRangeWithScores(
    LEADERBOARD_KEY,
    0,
    99,
    { REV: true }
  );

  // Fetch player details from MySQL for each player in the leaderboard
  const playerIds = leaderboard.map((player) => player.value);
  const [players] = await db.query<mysql.RowDataPacket[]>(
    `SELECT id, name, country, country_code FROM players WHERE id IN (?)`,
    [playerIds]
  );

  // Map the leaderboard data to include player details and ranking
  const result = leaderboard.map((player, index) => {
    const playerDetails = players.find((p) => p.id.toString() === player.value);
    return {
      ranking: index + 1,
      id: player.value,
      playerName: playerDetails ? playerDetails.name : null,
      country: playerDetails ? playerDetails.country : null,
      countryCode: playerDetails ? playerDetails.country_code : null,
      money: player.score,
    };
  });

  return result;
}

async function getPlayerDetails(
  playerId: string
): Promise<{
  name: string | null;
  country: string | null;
  country_code: string | null;
}> {
  if (!playerId) {
    return { name: null, country: null, country_code: null };
  }

  // Get player details from MySQL
  const [player] = await db.query<mysql.RowDataPacket[]>(
    "SELECT name, country, country_code FROM players WHERE id = ?",
    [playerId]
  );

  if (player.length === 0) {
    return { name: null, country: null, country_code: null };
  }

  return {
    name: player[0].name,
    country: player[0].country,
    country_code: player[0].country_code,
  };
}

async function getSearchResults(players: any[]) {
  let includedPlayerIds = new Set();
  const searchResults = await Promise.all(
    players.map(async (player) => {
      if (includedPlayerIds.has(player.id.toString())) return null;
      includedPlayerIds.add(player.id.toString());
      const rank = await redisClient.zRevRank(
        LEADERBOARD_KEY,
        player.id.toString()
      );
      const score = await redisClient.zScore(
        LEADERBOARD_KEY,
        player.id.toString()
      );

      if (rank === null) {
        console.error(
          `Inconsistency detected: Player ${player.id} exists in User DB but not in Leaderboard.`
        );
        logger.error(`Inconsistency detected: Player ${player.id} exists in User DB but not in Leaderboard.`);
        return null;
      }
      const startRank = rank - 3 < 0 ? 0 : rank - 3;
      const endRank = rank + 2;
      const surroundingPlayers = await redisClient.zRangeWithScores(
        LEADERBOARD_KEY,
        startRank,
        endRank,
        { REV: true }
      );

      let prevPlayers: any[] = [];
      let nextPlayers: any[] = [];

      await Promise.all(
        surroundingPlayers.map(async (player, index) => {
          const playerDetails = await getPlayerDetails(player.value);

          if (
            playerDetails.name === null ||
            playerDetails.country === null ||
            playerDetails.country_code === null
          ) {
            console.error(
              `Inconsistency detected: Player with ID ${player.value} exists in Leaderboard but corrupted in User DB.`
            );
            logger.error(`Inconsistency detected: Player with ID ${player.value} exists in Leaderboard but corrupted in User DB.`);
            return;
          }

          if (startRank + index < rank) {
            if (!includedPlayerIds.has(player.value)) {
              includedPlayerIds.add(player.value.toString());
              prevPlayers.push({
                ranking: startRank + index + 1,
                id: player.value,
                playerName: playerDetails.name,
                country: playerDetails.country,
                countryCode: playerDetails.country_code,
                money: Number(player.score),
              });
            }
          } else if (startRank + index > rank) {
            if (!includedPlayerIds.has(player.value)) {
              includedPlayerIds.add(player.value.toString());
              nextPlayers.push({
                ranking: startRank + index + 1,
                id: player.value,
                playerName: playerDetails.name,
                country: playerDetails.country,
                countryCode: playerDetails.country_code,
                money: Number(player.score),
              });
            }
          }
        })
      );
      return {
        id: player.id.toString(),
        ranking: rank + 1,
        playerName: player.name,
        country: player.country,
        countryCode: player.country_code,
        money: Number(score),
        surroundingPlayers: {
          prevPlayers: prevPlayers,
          nextPlayers: nextPlayers,
        },
      };
    })
  );
  return searchResults.filter((player) => player !== null);
}

app.get(
  "/leaderboard/top-ranking-data",
  async (req: Request, res: Response) => {
    try {
      const { query } = req.query;
      const topRankingPlayers = await getTopRankingPlayers();
      if (!query) return res.json({ topRankingPlayers, searchResults: null });

      const [players] = await db.query<mysql.RowDataPacket[]>(
        `SELECT id, name, country, country_code FROM players WHERE name LIKE ?`,
        [`%${query}%`]
      );

      if (!players.length)
        return res.json({ topRankingPlayers, searchResults: null });

      const playersWithRanks = await Promise.all(
        players.map(async (player) => {
          const rank = await redisClient.zRevRank(
            LEADERBOARD_KEY,
            player.id.toString()
          );
          if (rank === null) {
            console.error(
              `Inconsistency detected: Player ${player.id} exists in User DB but not in Leaderboard.`
            );
            logger.error(`Inconsistency detected: Player ${player.id} exists in User DB but not in Leaderboard.`);
            return null;
          }
          return {
            ...player,
            rank: rank + 1,
          };
        })
      );
      const filteredPlayers = playersWithRanks.filter(
        (player) => player !== null
      );
      filteredPlayers.sort((a, b) => a.rank - b.rank);
      
      const searchResults = await getSearchResults(filteredPlayers);

      res.json({ topRankingPlayers, searchResults });
    } catch (error: any) {
      console.error("Error getting top ranking data:", error);
      logger.error(`Error message: ${error?.message || "Unknown error"}, Error stack: ${error?.stack || "No stack trace"}`);
      return res
        .status(500)
        .json({ error: "Internal Server Error", details: error });
    }
  }
);

async function startServer() {
  try {
    await db.query("SELECT 1"); // Ensure MySQL is connected
    await redisClient.ping(); // Ensure Redis is connected
    app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();
