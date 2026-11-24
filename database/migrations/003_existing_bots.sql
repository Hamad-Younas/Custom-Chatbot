-- version: 1.2.0
-- description: Link chatbots that were already trained on the AI server (before this platform) by their bot id
-- Safe to re-run (IF NOT EXISTS).

ALTER TABLE `chatbots`
  ADD COLUMN IF NOT EXISTS `ai_bot_id` VARCHAR(64) NULL DEFAULT NULL COMMENT 'id of an existing, already-trained bot on the AI server; NULL = use public_id' AFTER `public_id`;

CREATE UNIQUE INDEX IF NOT EXISTS `uq_chatbots_ai_bot_id` ON `chatbots` (`ai_bot_id`);

INSERT INTO `schema_migrations` (`version`, `description`) VALUES ('1.2.0', 'Link existing trained bots')
  ON DUPLICATE KEY UPDATE `version` = `version`;
