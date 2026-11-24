-- version: 1.1.0
-- description: Columns used by the Node backend (draft widget config, visitor notes, digest, waiting alerts)
-- Safe to re-run (IF NOT EXISTS).

ALTER TABLE `chatbots`
  ADD COLUMN IF NOT EXISTS `draft_config` JSON NULL DEFAULT NULL COMMENT 'unpublished widget config edited in the dashboard; NULL = no unpublished changes' AFTER `onboarding_state`;

ALTER TABLE `visitors`
  ADD COLUMN IF NOT EXISTS `notes` TEXT NULL COMMENT 'private owner/agent notes about the visitor' AFTER `custom_attributes`;

ALTER TABLE `users`
  ADD COLUMN IF NOT EXISTS `notification_digest` ENUM('off','daily','weekly') NOT NULL DEFAULT 'off' AFTER `locale`;

ALTER TABLE `conversations`
  ADD COLUMN IF NOT EXISTS `waiting_alert_sent_at` DATETIME NULL DEFAULT NULL COMMENT 'conversation_waiting notification already sent' AFTER `human_request_reason`;

INSERT INTO `schema_migrations` (`version`, `description`) VALUES ('1.1.0', 'Backend support columns')
  ON DUPLICATE KEY UPDATE `version` = `version`;
