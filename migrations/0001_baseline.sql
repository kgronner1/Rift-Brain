/*!999999\- enable the sandbox mode */ 

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `user_accolades` (
  `user_id` int(10) unsigned NOT NULL,
  `Beaming` int(10) unsigned DEFAULT 0,
  `BigAssister` int(10) unsigned DEFAULT 0,
  `Bully` int(10) unsigned DEFAULT 0,
  `CleanUpCrew` int(10) unsigned DEFAULT 0,
  `ColdBlooded` int(10) unsigned DEFAULT 0,
  `Deflector` int(10) unsigned DEFAULT 0,
  `EarlyBird` int(10) unsigned DEFAULT 0,
  `Egalitarian` int(10) unsigned DEFAULT 0,
  `EtTuBrute` int(10) unsigned DEFAULT 0,
  `FreezeFrame` int(10) unsigned DEFAULT 0,
  `Ghost` int(10) unsigned DEFAULT 0,
  `GreenMachine` int(10) unsigned DEFAULT 0,
  `InYourFace` int(10) unsigned DEFAULT 0,
  `IrishGoodbye` int(10) unsigned DEFAULT 0,
  `Jumpy` int(10) unsigned DEFAULT 0,
  `LongShot` int(10) unsigned DEFAULT 0,
  `MachineGun` int(10) unsigned DEFAULT 0,
  `Nemesis` int(10) unsigned DEFAULT 0,
  `OneInchPunch` int(10) unsigned DEFAULT 0,
  `Pacifist` int(10) unsigned DEFAULT 0,
  `Pyromaniac` int(10) unsigned DEFAULT 0,
  `Quigley` int(10) unsigned DEFAULT 0,
  `RiftJumper` int(10) unsigned DEFAULT 0,
  `Sharpshooter` int(10) unsigned DEFAULT 0,
  `Sniper` int(10) unsigned DEFAULT 0,
  `StepInTheArena` int(10) unsigned DEFAULT 0,
  `StopHittingYourself` int(10) unsigned DEFAULT 0,
  `StudentDriver` int(10) unsigned DEFAULT 0,
  `TheLateShow` int(10) unsigned DEFAULT 0,
  `TriggerHappy` int(10) unsigned DEFAULT 0,
  `Underdog` int(10) unsigned DEFAULT 0,
  `VarietyShow` int(10) unsigned DEFAULT 0,
  `_last_updated` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `Hoarder` int(10) unsigned NOT NULL DEFAULT 0,
  `Bigwig` int(10) unsigned NOT NULL DEFAULT 0,
  `MonocleWearer` int(10) unsigned NOT NULL DEFAULT 0,
  `ScroogeMcDuck` int(10) unsigned NOT NULL DEFAULT 0,
  `CREAM` int(10) unsigned NOT NULL DEFAULT 0,
  `TakeaTen` int(10) unsigned NOT NULL DEFAULT 0,
  `GideonsHammock` int(10) unsigned NOT NULL DEFAULT 0,
  `AroundtheBlock` int(10) unsigned NOT NULL DEFAULT 0,
  `Tourist` int(10) unsigned NOT NULL DEFAULT 0,
  `Nomad` int(10) unsigned NOT NULL DEFAULT 0,
  `Globetrotter` int(10) unsigned NOT NULL DEFAULT 0,
  `Grasshopper` int(10) unsigned NOT NULL DEFAULT 0,
  `ForJoy` int(10) unsigned NOT NULL DEFAULT 0,
  `SharkJumper` int(10) unsigned NOT NULL DEFAULT 0,
  `StickyFingers` int(10) unsigned NOT NULL DEFAULT 0,
  `Ace` int(10) unsigned NOT NULL DEFAULT 0,
  `OneSmallStep` int(10) unsigned NOT NULL DEFAULT 0,
  `HonestDaysWork` int(10) unsigned NOT NULL DEFAULT 0,
  `AModestIncome` int(10) unsigned NOT NULL DEFAULT 0,
  `TheBacon` int(10) unsigned NOT NULL DEFAULT 0,
  `TheLongHaul` int(10) unsigned NOT NULL DEFAULT 0,
  `Loaded` int(10) unsigned NOT NULL DEFAULT 0,
  `Entourage` int(10) unsigned NOT NULL DEFAULT 0,
  `CultFollowing` int(10) unsigned NOT NULL DEFAULT 0,
  `Streaker` int(10) unsigned NOT NULL DEFAULT 0,
  `DucksinaRow` int(10) unsigned NOT NULL DEFAULT 0,
  `Eureka` int(10) unsigned NOT NULL DEFAULT 0,
  `PrematureFinisher` int(10) unsigned NOT NULL DEFAULT 0,
  `LeavingAlready` int(10) unsigned NOT NULL DEFAULT 0,
  `CouldveBeenanEmail` int(10) unsigned NOT NULL DEFAULT 0,
  `EnduranceAthlete` int(10) unsigned NOT NULL DEFAULT 0,
  `AscendantAttention` int(10) unsigned NOT NULL DEFAULT 0,
  `LikeClockwork` int(10) unsigned NOT NULL DEFAULT 0,
  `KeepitOneHundred` int(10) unsigned NOT NULL DEFAULT 0,
  `Quicksilver` int(10) unsigned NOT NULL DEFAULT 0,
  `FrequentFlyer` int(10) unsigned NOT NULL DEFAULT 0,
  `LudicrousSpeed` int(10) unsigned NOT NULL DEFAULT 0,
  `FTL` int(10) unsigned NOT NULL DEFAULT 0,
  PRIMARY KEY (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `user_accolades_time_earned` (
  `user_id` int(10) unsigned NOT NULL,
  `Beaming` timestamp NULL DEFAULT NULL,
  `BigAssister` timestamp NULL DEFAULT NULL,
  `Bully` timestamp NULL DEFAULT NULL,
  `CleanUpCrew` timestamp NULL DEFAULT NULL,
  `ColdBlooded` timestamp NULL DEFAULT NULL,
  `Deflector` timestamp NULL DEFAULT NULL,
  `EarlyBird` timestamp NULL DEFAULT NULL,
  `Egalitarian` timestamp NULL DEFAULT NULL,
  `EtTuBrute` timestamp NULL DEFAULT NULL,
  `FreezeFrame` timestamp NULL DEFAULT NULL,
  `Ghost` timestamp NULL DEFAULT NULL,
  `GreenMachine` timestamp NULL DEFAULT NULL,
  `InYourFace` timestamp NULL DEFAULT NULL,
  `IrishGoodbye` timestamp NULL DEFAULT NULL,
  `Jumpy` timestamp NULL DEFAULT NULL,
  `LongShot` timestamp NULL DEFAULT NULL,
  `MachineGun` timestamp NULL DEFAULT NULL,
  `Nemesis` timestamp NULL DEFAULT NULL,
  `OneInchPunch` timestamp NULL DEFAULT NULL,
  `Pacifist` timestamp NULL DEFAULT NULL,
  `Pyromaniac` timestamp NULL DEFAULT NULL,
  `Quigley` timestamp NULL DEFAULT NULL,
  `RiftJumper` timestamp NULL DEFAULT NULL,
  `Sharpshooter` timestamp NULL DEFAULT NULL,
  `Sniper` timestamp NULL DEFAULT NULL,
  `StepInTheArena` timestamp NULL DEFAULT NULL,
  `StopHittingYourself` timestamp NULL DEFAULT NULL,
  `StudentDriver` timestamp NULL DEFAULT NULL,
  `TheLateShow` timestamp NULL DEFAULT NULL,
  `TriggerHappy` timestamp NULL DEFAULT NULL,
  `Underdog` timestamp NULL DEFAULT NULL,
  `VarietyShow` timestamp NULL DEFAULT NULL,
  `Hoarder` timestamp NULL DEFAULT NULL,
  `Bigwig` timestamp NULL DEFAULT NULL,
  `MonocleWearer` timestamp NULL DEFAULT NULL,
  `ScroogeMcDuck` timestamp NULL DEFAULT NULL,
  `CREAM` timestamp NULL DEFAULT NULL,
  `TakeaTen` timestamp NULL DEFAULT NULL,
  `GideonsHammock` timestamp NULL DEFAULT NULL,
  `AroundtheBlock` timestamp NULL DEFAULT NULL,
  `Tourist` timestamp NULL DEFAULT NULL,
  `Nomad` timestamp NULL DEFAULT NULL,
  `Globetrotter` timestamp NULL DEFAULT NULL,
  `Grasshopper` timestamp NULL DEFAULT NULL,
  `ForJoy` timestamp NULL DEFAULT NULL,
  `SharkJumper` timestamp NULL DEFAULT NULL,
  `StickyFingers` timestamp NULL DEFAULT NULL,
  `Ace` timestamp NULL DEFAULT NULL,
  `OneSmallStep` timestamp NULL DEFAULT NULL,
  `HonestDaysWork` timestamp NULL DEFAULT NULL,
  `AModestIncome` timestamp NULL DEFAULT NULL,
  `TheBacon` timestamp NULL DEFAULT NULL,
  `TheLongHaul` timestamp NULL DEFAULT NULL,
  `Loaded` timestamp NULL DEFAULT NULL,
  `Entourage` timestamp NULL DEFAULT NULL,
  `CultFollowing` timestamp NULL DEFAULT NULL,
  `Streaker` timestamp NULL DEFAULT NULL,
  `DucksinaRow` timestamp NULL DEFAULT NULL,
  `Eureka` timestamp NULL DEFAULT NULL,
  `PrematureFinisher` timestamp NULL DEFAULT NULL,
  `LeavingAlready` timestamp NULL DEFAULT NULL,
  `CouldveBeenanEmail` timestamp NULL DEFAULT NULL,
  `EnduranceAthlete` timestamp NULL DEFAULT NULL,
  `AscendantAttention` timestamp NULL DEFAULT NULL,
  `LikeClockwork` timestamp NULL DEFAULT NULL,
  `KeepitOneHundred` timestamp NULL DEFAULT NULL,
  `Quicksilver` timestamp NULL DEFAULT NULL,
  `FrequentFlyer` timestamp NULL DEFAULT NULL,
  `LudicrousSpeed` timestamp NULL DEFAULT NULL,
  `FTL` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `user_player_card` (
  `user_id` int(11) NOT NULL,
  `equipped_accolade_key` varchar(64) NOT NULL DEFAULT '',
  `_last_updated` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`user_id`),
  CONSTRAINT `fk_player_card_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `user_stats` (
  `user_id` int(11) NOT NULL,
  `_last_updated` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `currency_amount` int(11) DEFAULT 0,
  `currency_earned_alltime` int(11) DEFAULT 0,
  `num_jumps_alltime` int(11) DEFAULT NULL,
  `num_unique_planets_visited_alltime` int(11) DEFAULT 0,
  `sp_most_currency_earned_in_a_run` int(11) DEFAULT 0,
  `sp_currency_earned_alltime` int(11) DEFAULT 0,
  `sp_highest_combo_alltime` int(11) DEFAULT 0,
  `sp_most_jumps_in_a_run` int(11) DEFAULT 0,
  `sp_most_unique_planets_visited_in_a_run` int(11) DEFAULT 0,
  `sp_most_levels_completed_in_a_run` int(11) DEFAULT 0,
  `sp_num_levels_completed_alltime` int(11) DEFAULT 0,
  `sp_most_asteroids_hit_in_a_run` int(11) DEFAULT 0,
  `sp_num_asteroids_hit_alltime` int(11) DEFAULT 0,
  `sp_longest_run_sec_alltime` float DEFAULT 0,
  `sp_total_time_spent_in_a_run_sec_alltime` float DEFAULT 0,
  `mp_num_matches_won_alltime` int(11) DEFAULT 0,
  `mp_num_matches_drawed_alltime` int(11) DEFAULT 0,
  `mp_num_matches_lost_alltime` int(11) DEFAULT 0,
  `mp_most_currency_earned_in_a_match` int(11) DEFAULT 0,
  `mp_currency_earned_alltime` int(11) DEFAULT 0,
  `mp_num_hits_received_alltime` int(11) DEFAULT 0,
  `mp_num_hits_dealt_alltime` int(11) DEFAULT 0,
  `mp_num_misses_dealt_alltime` int(11) DEFAULT 0,
  `mp_average_accuracy` float DEFAULT 0,
  `mp_num_kills_alltime` int(11) DEFAULT 0,
  `mp_num_deaths_by_other_players_alltime` int(11) DEFAULT 0,
  `mp_num_deaths_alltime` int(11) DEFAULT 0,
  `mp_most_kills_in_a_match` int(11) DEFAULT 0,
  `mp_longest_time_spent_alive_in_a_match_sec` float DEFAULT 0,
  `mp_total_time_spent_in_a_match_sec_alltime` float DEFAULT 0,
  `mp_most_jumps_in_a_match` int(11) DEFAULT 0,
  `mp_num_items_stolen_alltime` int(11) DEFAULT NULL,
  `mp_elo_rating` int(11) NOT NULL DEFAULT 1000,
  PRIMARY KEY (`user_id`),
  CONSTRAINT `fk_user_stats_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8 */;
CREATE TABLE `users` (
  `user_id` int(11) NOT NULL AUTO_INCREMENT,
  `username` varchar(255) NOT NULL,
  `email` varchar(255) NOT NULL,
  `password` varchar(255) NOT NULL,
  `access_token` varchar(255) DEFAULT NULL,
  `last_login` datetime DEFAULT current_timestamp(),
  `created_date` datetime DEFAULT current_timestamp(),
  PRIMARY KEY (`user_id`),
  UNIQUE KEY `username` (`username`),
  UNIQUE KEY `email` (`email`),
  UNIQUE KEY `access_token` (`access_token`),
  UNIQUE KEY `access_token_2` (`access_token`),
  UNIQUE KEY `access_token_3` (`access_token`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

