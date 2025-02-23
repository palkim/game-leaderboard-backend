# Leaderboard Backend

## Project Description

Leaderboard Backend is an application that tracks player earnings and manages leaderboards. It uses MySQL for storing player information and Redis for caching and quick access. Additionally, it manages weekly prize pools and updates player rankings.

## Features

- Create new players
- Update player earnings
- Reset weekly leaderboard
- Search and rank players

## Technologies

- **Node.js**: Server-side application development
- **Express**: Web application framework
- **MySQL**: Database management
- **Redis**: Caching for fast data access
- **Node-Cron**: For scheduled tasks

## Installation

### Requirements

- Node.js (v14 or higher)
- MySQL
- Redis

### Steps

1. **Clone the Repository**:
   ```bash
   git clone https://github.com/palkim/game-leaderboard-backend.git
   cd panteon-leaderboard-backend
   ```

2. **Install Dependencies**:
   ```bash
   npm install
   ```

3. **Set Up Environment Variables**:
   Create a `.env` file in the root directory and add your environment variables (e.g., database credentials).

4. **Run mysql and redis containers for running the project on your local**:
   ```bash
   docker-compose up
   ```

5. **Initialize the Database**:
   Run the SQL script `init.sql` to create the necessary tables:
   ```sql
   -- Run init.sql to set up the database
   CREATE TABLE players (
       id INT AUTO_INCREMENT PRIMARY KEY,
       name VARCHAR(255) NOT NULL,
       country VARCHAR(255) NOT NULL,
       country_code VARCHAR(10) NOT NULL
   );

   CREATE INDEX idx_players_name ON players(name);
   ```

6. **Start the Application**:
   ```bash
   npm run start
   ```

## Usage

- To create a new player, send a POST request to `/player/create` with the required player details (name, country, countryCode).
- To update player earnings, send a POST request to `/leaderboard/earn` with the playerId and amount.