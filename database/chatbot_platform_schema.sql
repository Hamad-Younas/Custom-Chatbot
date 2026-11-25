-- =====================================================================
--  AI CHATBOT SAAS PLATFORM - MariaDB schema  (v1.0.0)
--  Tested on MariaDB 10.11. Requires MariaDB 10.5+ (STORED generated columns, JSON alias).
--
--  HOW TO RUN:   mariadb -u root -p < chatbot_platform_schema.sql
--                (or paste into HeidiSQL / DBeaver / phpMyAdmin "SQL" tab and run as a script)
--
--  TO CHANGE THE DATABASE NAME: edit ONLY the first SET line below.
--  Safe to re-run: every statement is IF NOT EXISTS / INSERT IGNORE.
--
--  CONVENTIONS
--   * Every table has: is_deleted, deleted_at, created_at, updated_at.
--   * All DATETIME values are UTC: set the connection time zone to UTC in your app
--     (e.g. SET time_zone = '+00:00'), otherwise CURRENT_TIMESTAMP uses the server zone.
--   * Soft delete = is_deleted=1 (+deleted_at). Unique keys that must allow re-creation after a
--     soft delete include the generated column active_flag (1 while active, NULL once deleted).
--   * Always filter by chatbot_id / user_id (multi-tenant isolation) and is_deleted = 0.
--   * public ids (chatbots.public_id, visitors.visitor_uid, conversations.conversation_uid) are
--     identifiers, NOT credentials.
-- =====================================================================

SET @db_name = 'ibukotanusantara_chatbot_saas';           -- <<< CHANGE THE DATABASE NAME HERE (only here)

-- Optional: also create a least-privilege application user (0 = skip, 1 = create)
SET @create_app_user = 0;
SET @app_user        = 'chatbot_app';
SET @app_host        = '%';              -- e.g. '10.0.0.5' or 'localhost' to restrict
SET @app_password    = '';              -- required when @create_app_user = 1

-- ---------------------------------------------------------------------
SET SESSION sql_mode = REPLACE(@@sql_mode, 'ANSI_QUOTES', '');   -- the script uses "..." as string quotes
SET NAMES utf8mb4;
SET @OLD_FK = @@FOREIGN_KEY_CHECKS;
SET FOREIGN_KEY_CHECKS = 0;

SET @q = CONCAT('CREATE DATABASE IF NOT EXISTS `', @db_name, '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
PREPARE st FROM @q; EXECUTE st;

-- ---- users: Registered business accounts (tenants) and platform admins
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`users` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `uuid` CHAR(36) NOT NULL,
  `full_name` VARCHAR(150) NOT NULL,
  `email` VARCHAR(254) NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL COMMENT 'argon2id/bcrypt hash only',
  `role` ENUM('user','admin') NOT NULL DEFAULT 'user' COMMENT 'admin = platform operator',
  `status` ENUM('pending_verification','active','suspended','disabled') NOT NULL DEFAULT 'pending_verification',
  `email_verified_at` DATETIME NULL DEFAULT NULL,
  `profile_picture_file_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `timezone` VARCHAR(64) NOT NULL DEFAULT 'UTC',
  `locale` VARCHAR(16) NOT NULL DEFAULT 'en',
  `token_version` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'bump to revoke all access tokens',
  `failed_login_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `locked_until` DATETIME NULL DEFAULT NULL,
  `last_login_at` DATETIME NULL DEFAULT NULL,
  `last_login_ip` VARCHAR(45) NULL DEFAULT NULL,
  `password_changed_at` DATETIME NULL DEFAULT NULL,
  `terms_accepted_at` DATETIME NULL DEFAULT NULL,
  `chatbot_limit_override` INT UNSIGNED NULL DEFAULT NULL COMMENT 'NULL = use env MAX_CHATBOTS_PER_USER',
  `domain_limit_override` INT UNSIGNED NULL DEFAULT NULL COMMENT 'NULL = platform_settings.max_domains_per_chatbot',
  `onboarding_completed_at` DATETIME NULL DEFAULT NULL,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `active_flag` TINYINT(1) AS (IF(`is_deleted` = 0, 1, NULL)) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_users_uuid` (`uuid`),
  UNIQUE KEY `uq_users_email_active` (`email`, `active_flag`),
  KEY `idx_users_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Registered business accounts (tenants) and platform admins'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- uploaded_files: Uploaded images (profile pictures, logos, avatars, launcher icons)
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`uploaded_files` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `chatbot_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `purpose` ENUM('profile_picture','logo','avatar','launcher_icon','announcement_image','other') NOT NULL DEFAULT 'other',
  `storage_driver` VARCHAR(20) NOT NULL DEFAULT 'local',
  `storage_key` VARCHAR(500) NOT NULL,
  `original_name` VARCHAR(255) NULL DEFAULT NULL,
  `mime_type` VARCHAR(100) NOT NULL,
  `size_bytes` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `sha256` CHAR(64) NULL DEFAULT NULL,
  `width` INT UNSIGNED NULL DEFAULT NULL,
  `height` INT UNSIGNED NULL DEFAULT NULL,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_files_user` (`user_id`),
  KEY `idx_files_chatbot` (`chatbot_id`),
  CONSTRAINT `fk_uploaded_files_user_id` FOREIGN KEY (`user_id`) REFERENCES `{db}`.`users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Uploaded images (profile pictures, logos, avatars, launcher icons)'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- user_sessions: Refresh-token sessions (rotation, revocation, device list)
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`user_sessions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `session_uid` CHAR(36) NOT NULL,
  `refresh_token_hash` CHAR(64) NOT NULL COMMENT 'SHA-256 of the refresh token',
  `token_family` CHAR(36) NOT NULL COMMENT 'detects refresh-token reuse',
  `replaced_by_session_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `user_agent` VARCHAR(500) NULL DEFAULT NULL,
  `ip_address` VARCHAR(45) NULL DEFAULT NULL,
  `device_label` VARCHAR(150) NULL DEFAULT NULL,
  `expires_at` DATETIME NOT NULL,
  `last_used_at` DATETIME NULL DEFAULT NULL,
  `revoked_at` DATETIME NULL DEFAULT NULL,
  `revoked_reason` ENUM('logout','password_change','suspicious','admin','expired','rotated') NULL DEFAULT NULL,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sessions_uid` (`session_uid`),
  UNIQUE KEY `uq_sessions_token` (`refresh_token_hash`),
  KEY `idx_sessions_user` (`user_id`, `revoked_at`),
  KEY `idx_sessions_family` (`token_family`),
  KEY `idx_sessions_expires` (`expires_at`),
  CONSTRAINT `fk_user_sessions_user_id` FOREIGN KEY (`user_id`) REFERENCES `{db}`.`users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Refresh-token sessions (rotation, revocation, device list)'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- auth_tokens: One-time tokens: email verification, password reset, email change
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`auth_tokens` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `token_type` ENUM('email_verify','password_reset','email_change','invitation') NOT NULL,
  `token_hash` CHAR(64) NOT NULL,
  `new_email` VARCHAR(254) NULL DEFAULT NULL,
  `expires_at` DATETIME NOT NULL,
  `used_at` DATETIME NULL DEFAULT NULL,
  `request_ip` VARCHAR(45) NULL DEFAULT NULL,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_auth_tokens_hash` (`token_hash`),
  KEY `idx_auth_tokens_user` (`user_id`, `token_type`),
  KEY `idx_auth_tokens_expires` (`expires_at`),
  CONSTRAINT `fk_auth_tokens_user_id` FOREIGN KEY (`user_id`) REFERENCES `{db}`.`users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='One-time tokens: email verification, password reset, email change'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- login_attempts: Login/registration/reset attempts for abuse detection and lockout
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`login_attempts` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `email` VARCHAR(254) NULL DEFAULT NULL,
  `ip_address` VARCHAR(45) NULL DEFAULT NULL,
  `action` ENUM('login','register','verify_email','forgot_password','reset_password','refresh') NOT NULL DEFAULT 'login',
  `success` TINYINT(1) NOT NULL DEFAULT 0,
  `failure_reason` VARCHAR(100) NULL DEFAULT NULL,
  `user_agent` VARCHAR(500) NULL DEFAULT NULL,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_login_email` (`email`, `created_at`),
  KEY `idx_login_ip` (`ip_address`, `created_at`),
  CONSTRAINT `fk_login_attempts_user_id` FOREIGN KEY (`user_id`) REFERENCES `{db}`.`users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Login/registration/reset attempts for abuse detection and lockout'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- api_keys: Scoped API credentials (only the hash is stored; secret shown once)
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`api_keys` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `chatbot_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `name` VARCHAR(100) NOT NULL,
  `key_prefix` VARCHAR(12) NOT NULL,
  `key_hash` CHAR(64) NOT NULL,
  `scopes` JSON NULL DEFAULT NULL,
  `last_used_at` DATETIME NULL DEFAULT NULL,
  `last_used_ip` VARCHAR(45) NULL DEFAULT NULL,
  `expires_at` DATETIME NULL DEFAULT NULL,
  `revoked_at` DATETIME NULL DEFAULT NULL,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_api_keys_hash` (`key_hash`),
  KEY `idx_api_keys_user` (`user_id`),
  KEY `idx_api_keys_prefix` (`key_prefix`),
  CONSTRAINT `fk_api_keys_user_id` FOREIGN KEY (`user_id`) REFERENCES `{db}`.`users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Scoped API credentials (only the hash is stored; secret shown once)'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- chatbots: A chatbot owned by a user. public_id is the embed identifier and is also the id used by the Python AI service
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`chatbots` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id` VARCHAR(40) NOT NULL COMMENT 'e.g. bot_ + 24 random chars; goes in embed code and AI service',
  `user_id` BIGINT UNSIGNED NOT NULL,
  `name` VARCHAR(150) NOT NULL,
  `website_url` VARCHAR(2048) NULL DEFAULT NULL,
  `company_name` VARCHAR(150) NULL DEFAULT NULL,
  `topic` VARCHAR(255) NULL DEFAULT NULL COMMENT 'sent to the AI service as the site topic',
  `onboarding_step` ENUM('url','crawling','review','customize','faqs','preview','install','done') NOT NULL DEFAULT 'url',
  `onboarding_state` JSON NULL DEFAULT NULL COMMENT 'wizard draft data so users can resume',
  `status` ENUM('draft','training','ready','published','paused','failed') NOT NULL DEFAULT 'draft',
  `training_status` ENUM('not_started','crawling','awaiting_review','indexing','ready','failed') NOT NULL DEFAULT 'not_started',
  `last_training_job_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `last_trained_at` DATETIME NULL DEFAULT NULL,
  `pages_indexed` INT UNSIGNED NOT NULL DEFAULT 0,
  `knowledge_chunks` INT UNSIGNED NOT NULL DEFAULT 0,
  `is_published` TINYINT(1) NOT NULL DEFAULT 0,
  `published_at` DATETIME NULL DEFAULT NULL,
  `installation_status` ENUM('not_installed','detected','active','inactive','domain_verification_failed') NOT NULL DEFAULT 'not_installed',
  `widget_version` VARCHAR(20) NULL DEFAULT NULL COMMENT 'NULL = platform default (widget_versions.is_default)',
  `settings_version` INT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'bump on every config change; widget cache-busting',
  `ai_data_deleted_at` DATETIME NULL DEFAULT NULL COMMENT 'set when the AI service confirmed data removal',
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_chatbots_public_id` (`public_id`),
  KEY `idx_chatbots_user` (`user_id`, `is_deleted`),
  KEY `idx_chatbots_status` (`status`),
  CONSTRAINT `fk_chatbots_user_id` FOREIGN KEY (`user_id`) REFERENCES `{db}`.`users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='A chatbot owned by a user. public_id is the embed identifier and is also the id used by the Python AI service'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- chatbot_members: Team members/agents of a chatbot (owner is chatbots.user_id)
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`chatbot_members` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `chatbot_id` BIGINT UNSIGNED NOT NULL,
  `user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `invite_email` VARCHAR(254) NULL DEFAULT NULL,
  `role` ENUM('admin','agent') NOT NULL DEFAULT 'agent',
  `status` ENUM('invited','active','removed') NOT NULL DEFAULT 'invited',
  `permissions` JSON NULL DEFAULT NULL,
  `is_available` TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'agent availability for handovers',
  `last_seen_at` DATETIME NULL DEFAULT NULL,
  `invited_by` BIGINT UNSIGNED NULL DEFAULT NULL,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `active_flag` TINYINT(1) AS (IF(`is_deleted` = 0, 1, NULL)) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_members_chatbot_user` (`chatbot_id`, `user_id`, `active_flag`),
  KEY `idx_members_user` (`user_id`),
  CONSTRAINT `fk_chatbot_members_chatbot_id` FOREIGN KEY (`chatbot_id`) REFERENCES `{db}`.`chatbots` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_chatbot_members_user_id` FOREIGN KEY (`user_id`) REFERENCES `{db}`.`users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_chatbot_members_invited_by` FOREIGN KEY (`invited_by`) REFERENCES `{db}`.`users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Team members/agents of a chatbot (owner is chatbots.user_id)'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- widget_templates: Starter templates (seeded)
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`widget_templates` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `template_key` VARCHAR(50) NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `description` VARCHAR(500) NULL DEFAULT NULL,
  `default_config` JSON NULL DEFAULT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_templates_key` (`template_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Starter templates (seeded)'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- widget_versions: Embed SDK versions for safe updates
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`widget_versions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `version` VARCHAR(20) NOT NULL,
  `channel` ENUM('stable','beta') NOT NULL DEFAULT 'stable',
  `asset_url` VARCHAR(500) NULL DEFAULT NULL,
  `integrity_sha384` VARCHAR(100) NULL DEFAULT NULL,
  `is_default` TINYINT(1) NOT NULL DEFAULT 0,
  `release_notes` TEXT NULL,
  `released_at` DATETIME NULL DEFAULT NULL,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_widget_versions` (`version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Embed SDK versions for safe updates'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- chatbot_appearance: Visual customization (one row per chatbot)
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`chatbot_appearance` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `chatbot_id` BIGINT UNSIGNED NOT NULL,
  `template_key` VARCHAR(50) NOT NULL DEFAULT 'modern_minimal',
  `theme` ENUM('light','dark','auto') NOT NULL DEFAULT 'light',
  `primary_color` VARCHAR(9) NOT NULL DEFAULT '#1F3A5F',
  `secondary_color` VARCHAR(9) NOT NULL DEFAULT '#4A6FA5',
  `background_color` VARCHAR(9) NOT NULL DEFAULT '#FFFFFF',
  `text_color` VARCHAR(9) NOT NULL DEFAULT '#1F2328',
  `header_color` VARCHAR(9) NULL DEFAULT NULL,
  `header_text_color` VARCHAR(9) NULL DEFAULT NULL,
  `bot_bubble_color` VARCHAR(9) NULL DEFAULT NULL,
  `bot_bubble_text_color` VARCHAR(9) NULL DEFAULT NULL,
  `user_bubble_color` VARCHAR(9) NULL DEFAULT NULL,
  `user_bubble_text_color` VARCHAR(9) NULL DEFAULT NULL,
  `send_button_color` VARCHAR(9) NULL DEFAULT NULL,
  `gradient_css` VARCHAR(300) NULL DEFAULT NULL,
  `title` VARCHAR(100) NOT NULL DEFAULT 'Chat with us',
  `subtitle` VARCHAR(200) NULL DEFAULT NULL,
  `assistant_name` VARCHAR(60) NOT NULL DEFAULT 'Assistant',
  `company_branding` VARCHAR(150) NULL DEFAULT NULL,
  `show_powered_by` TINYINT(1) NOT NULL DEFAULT 1,
  `logo_file_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `avatar_file_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `launcher_icon` VARCHAR(50) NOT NULL DEFAULT 'chat',
  `launcher_icon_file_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `launcher_size` SMALLINT UNSIGNED NOT NULL DEFAULT 56,
  `launcher_animation` ENUM('none','pulse','bounce','wiggle') NOT NULL DEFAULT 'none',
  `position` ENUM('bottom-right','bottom-left') NOT NULL DEFAULT 'bottom-right',
  `offset_x` SMALLINT UNSIGNED NOT NULL DEFAULT 20,
  `offset_y` SMALLINT UNSIGNED NOT NULL DEFAULT 20,
  `width` SMALLINT UNSIGNED NOT NULL DEFAULT 380,
  `height` SMALLINT UNSIGNED NOT NULL DEFAULT 560,
  `border_radius` SMALLINT UNSIGNED NOT NULL DEFAULT 16,
  `shadow` ENUM('none','soft','medium','strong') NOT NULL DEFAULT 'medium',
  `spacing` ENUM('compact','comfortable','spacious') NOT NULL DEFAULT 'comfortable',
  `font_family` VARCHAR(150) NOT NULL DEFAULT 'system-ui',
  `font_size` TINYINT UNSIGNED NOT NULL DEFAULT 14,
  `message_style` ENUM('bubbles','flat','cards') NOT NULL DEFAULT 'bubbles',
  `mobile_layout` ENUM('fullscreen','floating') NOT NULL DEFAULT 'fullscreen',
  `show_timestamps` TINYINT(1) NOT NULL DEFAULT 1,
  `enable_emoji_picker` TINYINT(1) NOT NULL DEFAULT 1,
  `enable_copy_message` TINYINT(1) NOT NULL DEFAULT 1,
  `enable_animations` TINYINT(1) NOT NULL DEFAULT 1,
  `cta_style` ENUM('filled','outline','link') NOT NULL DEFAULT 'filled',
  `extra` JSON NULL DEFAULT NULL COMMENT 'forward-compatible extra options',
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_appearance_chatbot` (`chatbot_id`),
  CONSTRAINT `fk_chatbot_appearance_chatbot_id` FOREIGN KEY (`chatbot_id`) REFERENCES `{db}`.`chatbots` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Visual customization (one row per chatbot)'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- chatbot_settings: Behavior, AI, handover, availability and privacy settings (one row per chatbot)
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`chatbot_settings` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `chatbot_id` BIGINT UNSIGNED NOT NULL,
  `ai_enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `ai_tone` ENUM('friendly','professional','concise','playful') NOT NULL DEFAULT 'friendly',
  `custom_instructions` TEXT NULL COMMENT 'sent to AI service as instructions (max ~1000 chars used)',
  `ai_cutoff` DECIMAL(4,3) NOT NULL DEFAULT 0.700 COMMENT 'retrieval distance cutoff (lower = stricter)',
  `ai_top_k` TINYINT UNSIGNED NOT NULL DEFAULT 4,
  `language_mode` ENUM('auto','fixed') NOT NULL DEFAULT 'auto',
  `default_language` VARCHAR(16) NOT NULL DEFAULT 'en',
  `not_found_message` VARCHAR(500) NULL DEFAULT NULL,
  `error_message` VARCHAR(500) NULL DEFAULT NULL,
  `faq_first` TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'check FAQs before the AI service',
  `faq_match_threshold` DECIMAL(4,3) NOT NULL DEFAULT 0.850,
  `welcome_enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `show_suggested_questions` TINYINT(1) NOT NULL DEFAULT 1,
  `handover_detection_enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `handover_pause_policy` ENUM('on_accept','immediate') NOT NULL DEFAULT 'on_accept',
  `handover_requested_message` VARCHAR(500) NULL DEFAULT NULL,
  `no_agent_message` VARCHAR(500) NULL DEFAULT NULL,
  `collect_contact_when_offline` TINYINT(1) NOT NULL DEFAULT 1,
  `availability_mode` ENUM('auto','always_online','always_offline') NOT NULL DEFAULT 'auto',
  `online_text` VARCHAR(150) NULL DEFAULT 'We typically reply instantly',
  `offline_text` VARCHAR(150) NULL DEFAULT 'We are offline right now',
  `business_timezone` VARCHAR(64) NOT NULL DEFAULT 'UTC',
  `business_hours` JSON NULL DEFAULT NULL COMMENT '{\"mon\":[[\"09:00\",\"17:00\"]],...}',
  `max_message_length` SMALLINT UNSIGNED NOT NULL DEFAULT 500,
  `max_messages_per_minute` SMALLINT UNSIGNED NOT NULL DEFAULT 10,
  `daily_ai_limit` INT UNSIGNED NULL DEFAULT NULL,
  `consent_required` TINYINT(1) NOT NULL DEFAULT 0,
  `consent_text` VARCHAR(500) NULL DEFAULT NULL,
  `privacy_policy_url` VARCHAR(500) NULL DEFAULT NULL,
  `consent_policy_version` VARCHAR(20) NOT NULL DEFAULT '1',
  `track_visitors` TINYINT(1) NOT NULL DEFAULT 1,
  `store_ip_address` TINYINT(1) NOT NULL DEFAULT 0,
  `retention_days_conversations` INT UNSIGNED NULL DEFAULT NULL COMMENT 'NULL = keep forever',
  `retention_days_visitors` INT UNSIGNED NULL DEFAULT NULL,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_chatbot_settings_chatbot` (`chatbot_id`),
  CONSTRAINT `fk_chatbot_settings_chatbot_id` FOREIGN KEY (`chatbot_id`) REFERENCES `{db}`.`chatbots` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Behavior, AI, handover, availability and privacy settings (one row per chatbot)'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- welcome_messages: Welcome messages (multiple allowed for future scheduling/targeting)
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`welcome_messages` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `chatbot_id` BIGINT UNSIGNED NOT NULL,
  `message` TEXT NOT NULL,
  `is_enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `priority` INT NOT NULL DEFAULT 0,
  `starts_at` DATETIME NULL DEFAULT NULL,
  `ends_at` DATETIME NULL DEFAULT NULL,
  `target_rules` JSON NULL DEFAULT NULL COMMENT 'future: url/country/new-vs-returning targeting',
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_welcome_chatbot` (`chatbot_id`, `is_enabled`),
  CONSTRAINT `fk_welcome_messages_chatbot_id` FOREIGN KEY (`chatbot_id`) REFERENCES `{db}`.`chatbots` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Welcome messages (multiple allowed for future scheduling/targeting)'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- suggested_questions: Conversation starters shown in the welcome panel
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`suggested_questions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `chatbot_id` BIGINT UNSIGNED NOT NULL,
  `question` VARCHAR(300) NOT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `is_enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_suggested_chatbot` (`chatbot_id`, `is_enabled`, `sort_order`),
  CONSTRAINT `fk_suggested_questions_chatbot_id` FOREIGN KEY (`chatbot_id`) REFERENCES `{db}`.`chatbots` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Conversation starters shown in the welcome panel'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- cta_buttons: Call-to-action buttons in the welcome panel
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`cta_buttons` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `chatbot_id` BIGINT UNSIGNED NOT NULL,
  `label` VARCHAR(100) NOT NULL,
  `action_type` ENUM('link','send_message','request_human','open_form') NOT NULL DEFAULT 'link',
  `url` VARCHAR(2048) NULL DEFAULT NULL,
  `message` VARCHAR(300) NULL DEFAULT NULL,
  `open_in_new_tab` TINYINT(1) NOT NULL DEFAULT 1,
  `sort_order` INT NOT NULL DEFAULT 0,
  `is_enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_cta_chatbot` (`chatbot_id`, `is_enabled`, `sort_order`),
  CONSTRAINT `fk_cta_buttons_chatbot_id` FOREIGN KEY (`chatbot_id`) REFERENCES `{db}`.`chatbots` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Call-to-action buttons in the welcome panel'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- announcements: Promotional/announcement widget in the chat panel
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`announcements` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `chatbot_id` BIGINT UNSIGNED NOT NULL,
  `title` VARCHAR(150) NOT NULL,
  `body` VARCHAR(1000) NULL DEFAULT NULL,
  `image_file_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `link_url` VARCHAR(2048) NULL DEFAULT NULL,
  `link_label` VARCHAR(100) NULL DEFAULT NULL,
  `is_enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `starts_at` DATETIME NULL DEFAULT NULL,
  `ends_at` DATETIME NULL DEFAULT NULL,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_announcements_chatbot` (`chatbot_id`, `is_enabled`),
  CONSTRAINT `fk_announcements_chatbot_id` FOREIGN KEY (`chatbot_id`) REFERENCES `{db}`.`chatbots` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Promotional/announcement widget in the chat panel'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- knowledge_sources: Root website URLs and manual knowledge entries
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`knowledge_sources` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `chatbot_id` BIGINT UNSIGNED NOT NULL,
  `source_type` ENUM('website_url','manual') NOT NULL,
  `url` VARCHAR(2048) NULL DEFAULT NULL,
  `title` VARCHAR(255) NULL DEFAULT NULL,
  `content` MEDIUMTEXT NULL COMMENT 'manual entries: source of truth, re-sent to AI service on every index',
  `is_enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `status` ENUM('pending','active','failed') NOT NULL DEFAULT 'pending',
  `last_error` VARCHAR(500) NULL DEFAULT NULL,
  `last_crawled_at` DATETIME NULL DEFAULT NULL,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_sources_chatbot` (`chatbot_id`, `source_type`, `is_enabled`),
  CONSTRAINT `fk_knowledge_sources_chatbot_id` FOREIGN KEY (`chatbot_id`) REFERENCES `{db}`.`chatbots` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Root website URLs and manual knowledge entries'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- knowledge_exclusion_rules: Paths/URLs the owner excluded from crawling or indexing
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`knowledge_exclusion_rules` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `chatbot_id` BIGINT UNSIGNED NOT NULL,
  `rule_type` ENUM('path_prefix','url','regex') NOT NULL DEFAULT 'path_prefix',
  `pattern` VARCHAR(1000) NOT NULL,
  `note` VARCHAR(255) NULL DEFAULT NULL,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_exclusions_chatbot` (`chatbot_id`),
  CONSTRAINT `fk_knowledge_exclusion_rules_chatbot_id` FOREIGN KEY (`chatbot_id`) REFERENCES `{db}`.`chatbots` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Paths/URLs the owner excluded from crawling or indexing'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- training_jobs: Crawl / index jobs run by the Python AI service
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`training_jobs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `chatbot_id` BIGINT UNSIGNED NOT NULL,
  `job_uid` VARCHAR(64) NULL DEFAULT NULL COMMENT 'job_id returned by the AI service',
  `job_type` ENUM('crawl','index','full','delete') NOT NULL DEFAULT 'full',
  `status` ENUM('queued','running','succeeded','failed','cancelled') NOT NULL DEFAULT 'queued',
  `stage` VARCHAR(30) NULL DEFAULT NULL,
  `progress_percent` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `pages_discovered` INT UNSIGNED NOT NULL DEFAULT 0,
  `pages_extracted` INT UNSIGNED NOT NULL DEFAULT 0,
  `pages_indexed` INT UNSIGNED NOT NULL DEFAULT 0,
  `chunks_created` INT UNSIGNED NOT NULL DEFAULT 0,
  `options` JSON NULL DEFAULT NULL,
  `result` JSON NULL DEFAULT NULL,
  `error_message` TEXT NULL,
  `attempt` INT UNSIGNED NOT NULL DEFAULT 1,
  `retry_of_job_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `requested_by` BIGINT UNSIGNED NULL DEFAULT NULL,
  `started_at` DATETIME NULL DEFAULT NULL,
  `finished_at` DATETIME NULL DEFAULT NULL,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_training_job_uid` (`job_uid`),
  KEY `idx_training_chatbot` (`chatbot_id`, `created_at`),
  KEY `idx_training_status` (`status`),
  CONSTRAINT `fk_training_jobs_chatbot_id` FOREIGN KEY (`chatbot_id`) REFERENCES `{db}`.`chatbots` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_training_jobs_requested_by` FOREIGN KEY (`requested_by`) REFERENCES `{db}`.`users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Crawl / index jobs run by the Python AI service'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- knowledge_pages: Crawled pages shown in the review screen
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`knowledge_pages` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `chatbot_id` BIGINT UNSIGNED NOT NULL,
  `source_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `url` VARCHAR(2048) NOT NULL,
  `url_hash` CHAR(64) AS (SHA2(`url`, 256)) STORED,
  `title` VARCHAR(500) NULL DEFAULT NULL,
  `status` ENUM('discovered','extracted','indexed','failed','thin','empty','blocked','duplicate') NOT NULL DEFAULT 'discovered',
  `is_excluded` TINYINT(1) NOT NULL DEFAULT 0,
  `exclude_reason` VARCHAR(255) NULL DEFAULT NULL,
  `chars` INT UNSIGNED NOT NULL DEFAULT 0,
  `http_status` SMALLINT UNSIGNED NULL DEFAULT NULL,
  `extract_method` VARCHAR(30) NULL DEFAULT NULL,
  `duplicate_of_url` VARCHAR(2048) NULL DEFAULT NULL,
  `notes` VARCHAR(500) NULL DEFAULT NULL,
  `last_job_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `crawled_at` DATETIME NULL DEFAULT NULL,
  `indexed_at` DATETIME NULL DEFAULT NULL,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_pages_chatbot_url` (`chatbot_id`, `url_hash`),
  KEY `idx_pages_chatbot_status` (`chatbot_id`, `status`, `is_excluded`),
  CONSTRAINT `fk_knowledge_pages_chatbot_id` FOREIGN KEY (`chatbot_id`) REFERENCES `{db}`.`chatbots` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_knowledge_pages_source_id` FOREIGN KEY (`source_id`) REFERENCES `{db}`.`knowledge_sources` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_knowledge_pages_last_job_id` FOREIGN KEY (`last_job_id`) REFERENCES `{db}`.`training_jobs` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Crawled pages shown in the review screen'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- faqs: Predefined questions and answers (checked before the AI service)
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`faqs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `chatbot_id` BIGINT UNSIGNED NOT NULL,
  `question` VARCHAR(500) NOT NULL,
  `answer` TEXT NOT NULL,
  `category` VARCHAR(100) NULL DEFAULT NULL,
  `language` VARCHAR(16) NULL DEFAULT NULL,
  `is_enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `sort_order` INT NOT NULL DEFAULT 0,
  `match_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `last_matched_at` DATETIME NULL DEFAULT NULL,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_faqs_chatbot` (`chatbot_id`, `is_enabled`, `sort_order`),
  FULLTEXT KEY `ft_faqs_question` (`question`),
  CONSTRAINT `fk_faqs_chatbot_id` FOREIGN KEY (`chatbot_id`) REFERENCES `{db}`.`chatbots` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Predefined questions and answers (checked before the AI service)'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- faq_variants: Alternative phrasings, synonyms and misspellings of an FAQ question
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`faq_variants` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `faq_id` BIGINT UNSIGNED NOT NULL,
  `chatbot_id` BIGINT UNSIGNED NOT NULL,
  `variant_text` VARCHAR(500) NOT NULL,
  `normalized_text` VARCHAR(500) NOT NULL COMMENT 'lowercased, punctuation-stripped by the app',
  `normalized_hash` CHAR(64) AS (SHA2(`normalized_text`, 256)) STORED,
  `variant_type` ENUM('phrasing','synonym','misspelling') NOT NULL DEFAULT 'phrasing',
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_variants_faq` (`faq_id`),
  KEY `idx_variants_lookup` (`chatbot_id`, `normalized_hash`),
  FULLTEXT KEY `ft_variants_text` (`variant_text`),
  CONSTRAINT `fk_faq_variants_faq_id` FOREIGN KEY (`faq_id`) REFERENCES `{db}`.`faqs` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_faq_variants_chatbot_id` FOREIGN KEY (`chatbot_id`) REFERENCES `{db}`.`chatbots` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Alternative phrasings, synonyms and misspellings of an FAQ question'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- chatbot_domains: Allowed domains for the widget
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`chatbot_domains` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `chatbot_id` BIGINT UNSIGNED NOT NULL,
  `domain` VARCHAR(253) NOT NULL COMMENT 'host only, lowercase, no scheme/port/path',
  `allow_subdomains` TINYINT(1) NOT NULL DEFAULT 0,
  `is_enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `verification_status` ENUM('unverified','verified','failed') NOT NULL DEFAULT 'unverified',
  `verification_method` ENUM('none','embed_detected','dns_txt','meta_tag') NOT NULL DEFAULT 'none',
  `verification_token` VARCHAR(64) NULL DEFAULT NULL,
  `verified_at` DATETIME NULL DEFAULT NULL,
  `last_seen_at` DATETIME NULL DEFAULT NULL,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `active_flag` TINYINT(1) AS (IF(`is_deleted` = 0, 1, NULL)) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_domains_chatbot_domain` (`chatbot_id`, `domain`, `active_flag`),
  KEY `idx_domains_lookup` (`domain`, `is_enabled`),
  CONSTRAINT `fk_chatbot_domains_chatbot_id` FOREIGN KEY (`chatbot_id`) REFERENCES `{db}`.`chatbots` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Allowed domains for the widget'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- chatbot_installations: Where the widget was seen loading (per host)
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`chatbot_installations` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `chatbot_id` BIGINT UNSIGNED NOT NULL,
  `domain_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `origin_host` VARCHAR(253) NOT NULL,
  `status` ENUM('detected','active','inactive','domain_failed') NOT NULL DEFAULT 'detected',
  `page_url_sample` VARCHAR(2048) NULL DEFAULT NULL,
  `widget_version` VARCHAR(20) NULL DEFAULT NULL,
  `first_detected_at` DATETIME NULL DEFAULT NULL,
  `last_seen_at` DATETIME NULL DEFAULT NULL,
  `load_count` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `unauthorized_attempts` INT UNSIGNED NOT NULL DEFAULT 0,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `active_flag` TINYINT(1) AS (IF(`is_deleted` = 0, 1, NULL)) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_installations_host` (`chatbot_id`, `origin_host`, `active_flag`),
  KEY `idx_installations_status` (`chatbot_id`, `status`),
  CONSTRAINT `fk_chatbot_installations_chatbot_id` FOREIGN KEY (`chatbot_id`) REFERENCES `{db}`.`chatbots` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_chatbot_installations_domain_id` FOREIGN KEY (`domain_id`) REFERENCES `{db}`.`chatbot_domains` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Where the widget was seen loading (per host)'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- visitors: Recognized visitors of a chatbot
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`visitors` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `chatbot_id` BIGINT UNSIGNED NOT NULL,
  `visitor_uid` VARCHAR(64) NOT NULL COMMENT 'public visitor ID - NOT a credential',
  `name` VARCHAR(150) NULL DEFAULT NULL,
  `email` VARCHAR(254) NULL DEFAULT NULL,
  `phone` VARCHAR(30) NULL DEFAULT NULL,
  `fingerprint_hash` CHAR(64) NULL DEFAULT NULL COMMENT 'salted hash to recognize returning browsers safely',
  `first_seen_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_seen_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_conversation_at` DATETIME NULL DEFAULT NULL,
  `visit_count` INT UNSIGNED NOT NULL DEFAULT 1,
  `conversation_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `ip_hash` CHAR(64) NULL DEFAULT NULL,
  `ip_address` VARCHAR(45) NULL DEFAULT NULL COMMENT 'only if chatbot_settings.store_ip_address',
  `user_agent` VARCHAR(500) NULL DEFAULT NULL,
  `browser` VARCHAR(60) NULL DEFAULT NULL,
  `os` VARCHAR(60) NULL DEFAULT NULL,
  `device_type` ENUM('desktop','mobile','tablet','bot','unknown') NOT NULL DEFAULT 'unknown',
  `country_code` CHAR(2) NULL DEFAULT NULL,
  `city` VARCHAR(100) NULL DEFAULT NULL,
  `language` VARCHAR(16) NULL DEFAULT NULL,
  `referrer` VARCHAR(2048) NULL DEFAULT NULL,
  `first_page_url` VARCHAR(2048) NULL DEFAULT NULL,
  `last_page_url` VARCHAR(2048) NULL DEFAULT NULL,
  `consent_status` ENUM('unknown','granted','denied','withdrawn') NOT NULL DEFAULT 'unknown',
  `consent_at` DATETIME NULL DEFAULT NULL,
  `custom_attributes` JSON NULL DEFAULT NULL,
  `anonymized_at` DATETIME NULL DEFAULT NULL,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_visitors_uid` (`chatbot_id`, `visitor_uid`),
  KEY `idx_visitors_first_seen` (`chatbot_id`, `first_seen_at`),
  KEY `idx_visitors_last_seen` (`chatbot_id`, `last_seen_at`),
  KEY `idx_visitors_fingerprint` (`chatbot_id`, `fingerprint_hash`),
  KEY `idx_visitors_email` (`chatbot_id`, `email`),
  CONSTRAINT `fk_visitors_chatbot_id` FOREIGN KEY (`chatbot_id`) REFERENCES `{db}`.`chatbots` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Recognized visitors of a chatbot'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- visitor_sessions: Visit sessions (for visitors-over-time charts)
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`visitor_sessions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `chatbot_id` BIGINT UNSIGNED NOT NULL,
  `visitor_id` BIGINT UNSIGNED NOT NULL,
  `session_uid` VARCHAR(64) NOT NULL,
  `started_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_activity_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `page_url` VARCHAR(2048) NULL DEFAULT NULL,
  `referrer` VARCHAR(2048) NULL DEFAULT NULL,
  `origin_host` VARCHAR(253) NULL DEFAULT NULL,
  `is_new_visitor` TINYINT(1) NOT NULL DEFAULT 0,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_vsessions_uid` (`chatbot_id`, `session_uid`),
  KEY `idx_vsessions_started` (`chatbot_id`, `started_at`),
  KEY `idx_vsessions_visitor` (`visitor_id`),
  CONSTRAINT `fk_visitor_sessions_chatbot_id` FOREIGN KEY (`chatbot_id`) REFERENCES `{db}`.`chatbots` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_visitor_sessions_visitor_id` FOREIGN KEY (`visitor_id`) REFERENCES `{db}`.`visitors` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Visit sessions (for visitors-over-time charts)'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- visitor_consents: Consent history per visitor
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`visitor_consents` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `chatbot_id` BIGINT UNSIGNED NOT NULL,
  `visitor_id` BIGINT UNSIGNED NOT NULL,
  `consent_type` ENUM('chat_storage','tracking','contact') NOT NULL DEFAULT 'chat_storage',
  `status` ENUM('granted','denied','withdrawn') NOT NULL,
  `policy_version` VARCHAR(20) NULL DEFAULT NULL,
  `ip_hash` CHAR(64) NULL DEFAULT NULL,
  `given_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_consents_visitor` (`visitor_id`),
  CONSTRAINT `fk_visitor_consents_chatbot_id` FOREIGN KEY (`chatbot_id`) REFERENCES `{db}`.`chatbots` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_visitor_consents_visitor_id` FOREIGN KEY (`visitor_id`) REFERENCES `{db}`.`visitors` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Consent history per visitor'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- conversations: One row per conversation. handling_mode + mode_version enforce a single responder
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`conversations` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `chatbot_id` BIGINT UNSIGNED NOT NULL,
  `conversation_uid` VARCHAR(64) NOT NULL COMMENT 'public conversation ID - NOT a credential',
  `visitor_id` BIGINT UNSIGNED NOT NULL,
  `status` ENUM('open','waiting_human','resolved','closed') NOT NULL DEFAULT 'open',
  `handling_mode` ENUM('ai','human') NOT NULL DEFAULT 'ai',
  `mode_version` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'optimistic lock: UPDATE ... WHERE handling_mode=? AND mode_version=?',
  `assigned_agent_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `human_requested` TINYINT(1) NOT NULL DEFAULT 0,
  `human_requested_at` DATETIME NULL DEFAULT NULL,
  `human_request_reason` VARCHAR(255) NULL DEFAULT NULL,
  `had_human_handover` TINYINT(1) NOT NULL DEFAULT 0,
  `taken_over_at` DATETIME NULL DEFAULT NULL,
  `returned_to_ai_at` DATETIME NULL DEFAULT NULL,
  `resolution_type` ENUM('ai_resolved','human_resolved','abandoned','unresolved') NULL DEFAULT NULL,
  `resolved_at` DATETIME NULL DEFAULT NULL,
  `resolved_by_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `channel` ENUM('widget','preview','api') NOT NULL DEFAULT 'widget',
  `is_test` TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'preview chats excluded from analytics',
  `language` VARCHAR(16) NULL DEFAULT NULL,
  `page_url` VARCHAR(2048) NULL DEFAULT NULL,
  `first_message_at` DATETIME NULL DEFAULT NULL,
  `first_response_at` DATETIME NULL DEFAULT NULL,
  `last_message_at` DATETIME NULL DEFAULT NULL,
  `last_message_preview` VARCHAR(255) NULL DEFAULT NULL,
  `last_message_sender` ENUM('visitor','ai','human','system') NULL DEFAULT NULL,
  `unread_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `message_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `visitor_message_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `ai_message_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `human_message_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `unanswered_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_conversations_uid` (`conversation_uid`),
  KEY `idx_conv_list` (`chatbot_id`, `is_deleted`, `last_message_at`),
  KEY `idx_conv_status` (`chatbot_id`, `status`, `last_message_at`),
  KEY `idx_conv_human` (`chatbot_id`, `human_requested`, `status`),
  KEY `idx_conv_visitor` (`visitor_id`),
  KEY `idx_conv_agent` (`assigned_agent_id`),
  KEY `idx_conv_created` (`chatbot_id`, `created_at`),
  CONSTRAINT `fk_conversations_chatbot_id` FOREIGN KEY (`chatbot_id`) REFERENCES `{db}`.`chatbots` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_conversations_visitor_id` FOREIGN KEY (`visitor_id`) REFERENCES `{db}`.`visitors` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_conversations_assigned_agent_id` FOREIGN KEY (`assigned_agent_id`) REFERENCES `{db}`.`users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_conversations_resolved_by_user_id` FOREIGN KEY (`resolved_by_user_id`) REFERENCES `{db}`.`users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='One row per conversation. handling_mode + mode_version enforce a single responder'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- messages: All visitor, AI, human and system messages
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`messages` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `conversation_id` BIGINT UNSIGNED NOT NULL,
  `chatbot_id` BIGINT UNSIGNED NOT NULL,
  `client_message_id` VARCHAR(64) NULL DEFAULT NULL COMMENT 'client-generated id: dedupe on retry/reconnect',
  `sender_type` ENUM('visitor','ai','human','system') NOT NULL,
  `sender_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `content` TEXT NOT NULL,
  `content_type` ENUM('text','system_event') NOT NULL DEFAULT 'text',
  `answer_source` ENUM('faq','ai_rag','ai_smalltalk','action_flow','human','system','canned') NULL DEFAULT NULL,
  `faq_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `ai_status` ENUM('answered','not_found','busy','error','smalltalk','handover') NULL DEFAULT NULL,
  `is_unanswered` TINYINT(1) NOT NULL DEFAULT 0,
  `sources` JSON NULL DEFAULT NULL COMMENT 'citation URLs from the AI service',
  `language` VARCHAR(16) NULL DEFAULT NULL,
  `ai_model` VARCHAR(100) NULL DEFAULT NULL,
  `ai_latency_ms` INT UNSIGNED NULL DEFAULT NULL,
  `prompt_tokens` INT UNSIGNED NULL DEFAULT NULL,
  `completion_tokens` INT UNSIGNED NULL DEFAULT NULL,
  `delivery_status` ENUM('pending','sent','delivered','read','failed') NOT NULL DEFAULT 'sent',
  `delivered_at` DATETIME NULL DEFAULT NULL,
  `read_at` DATETIME NULL DEFAULT NULL,
  `error_code` VARCHAR(50) NULL DEFAULT NULL,
  `reply_to_message_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `sent_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `metadata` JSON NULL DEFAULT NULL,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_messages_client_id` (`conversation_id`, `client_message_id`),
  KEY `idx_messages_conversation` (`conversation_id`, `id`),
  KEY `idx_messages_chatbot_time` (`chatbot_id`, `sent_at`),
  KEY `idx_messages_unanswered` (`chatbot_id`, `is_unanswered`, `sent_at`),
  KEY `idx_messages_faq` (`faq_id`),
  CONSTRAINT `fk_messages_conversation_id` FOREIGN KEY (`conversation_id`) REFERENCES `{db}`.`conversations` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_messages_chatbot_id` FOREIGN KEY (`chatbot_id`) REFERENCES `{db}`.`chatbots` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_messages_sender_user_id` FOREIGN KEY (`sender_user_id`) REFERENCES `{db}`.`users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_messages_faq_id` FOREIGN KEY (`faq_id`) REFERENCES `{db}`.`faqs` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='All visitor, AI, human and system messages'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- conversation_events: Timeline of mode/status/assignment changes (handover trends, audit of takeovers)
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`conversation_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `conversation_id` BIGINT UNSIGNED NOT NULL,
  `chatbot_id` BIGINT UNSIGNED NOT NULL,
  `event_type` ENUM('created','human_requested','takeover','return_to_ai','assigned','unassigned','resolved','reopened','closed','agent_accepted','no_agent_available') NOT NULL,
  `actor_type` ENUM('visitor','ai','agent','system') NOT NULL DEFAULT 'system',
  `actor_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `from_value` VARCHAR(50) NULL DEFAULT NULL,
  `to_value` VARCHAR(50) NULL DEFAULT NULL,
  `metadata` JSON NULL DEFAULT NULL,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_cevents_conversation` (`conversation_id`, `created_at`),
  KEY `idx_cevents_chatbot` (`chatbot_id`, `event_type`, `created_at`),
  CONSTRAINT `fk_conversation_events_conversation_id` FOREIGN KEY (`conversation_id`) REFERENCES `{db}`.`conversations` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_conversation_events_chatbot_id` FOREIGN KEY (`chatbot_id`) REFERENCES `{db}`.`chatbots` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_conversation_events_actor_user_id` FOREIGN KEY (`actor_user_id`) REFERENCES `{db}`.`users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Timeline of mode/status/assignment changes (handover trends, audit of takeovers)'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- unanswered_questions: Questions the AI could not answer reliably (owner can turn them into FAQs)
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`unanswered_questions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `chatbot_id` BIGINT UNSIGNED NOT NULL,
  `conversation_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `message_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `visitor_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `question` VARCHAR(1000) NOT NULL,
  `normalized_question` VARCHAR(500) NULL DEFAULT NULL,
  `reason` ENUM('no_relevant_context','ai_error','rate_limited','low_confidence') NOT NULL DEFAULT 'no_relevant_context',
  `status` ENUM('open','faq_created','dismissed','resolved') NOT NULL DEFAULT 'open',
  `resolved_faq_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `occurrences` INT UNSIGNED NOT NULL DEFAULT 1,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_unanswered_chatbot` (`chatbot_id`, `status`, `created_at`),
  KEY `idx_unanswered_norm` (`chatbot_id`, `normalized_question`(191)),
  CONSTRAINT `fk_unanswered_questions_chatbot_id` FOREIGN KEY (`chatbot_id`) REFERENCES `{db}`.`chatbots` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_unanswered_questions_conversation_id` FOREIGN KEY (`conversation_id`) REFERENCES `{db}`.`conversations` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_unanswered_questions_message_id` FOREIGN KEY (`message_id`) REFERENCES `{db}`.`messages` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_unanswered_questions_visitor_id` FOREIGN KEY (`visitor_id`) REFERENCES `{db}`.`visitors` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_unanswered_questions_resolved_faq_id` FOREIGN KEY (`resolved_faq_id`) REFERENCES `{db}`.`faqs` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Questions the AI could not answer reliably (owner can turn them into FAQs)'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- leads: Contact details collected from visitors
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`leads` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `chatbot_id` BIGINT UNSIGNED NOT NULL,
  `visitor_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `conversation_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `reference_code` VARCHAR(20) NULL DEFAULT NULL,
  `name` VARCHAR(150) NULL DEFAULT NULL,
  `email` VARCHAR(254) NULL DEFAULT NULL,
  `phone` VARCHAR(30) NULL DEFAULT NULL,
  `message` TEXT NULL,
  `custom_fields` JSON NULL DEFAULT NULL,
  `source` ENUM('offline_form','action_flow','handover_form','manual') NOT NULL DEFAULT 'offline_form',
  `status` ENUM('new','contacted','qualified','closed') NOT NULL DEFAULT 'new',
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_leads_chatbot` (`chatbot_id`, `status`, `created_at`),
  KEY `idx_leads_email` (`chatbot_id`, `email`),
  CONSTRAINT `fk_leads_chatbot_id` FOREIGN KEY (`chatbot_id`) REFERENCES `{db}`.`chatbots` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_leads_visitor_id` FOREIGN KEY (`visitor_id`) REFERENCES `{db}`.`visitors` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_leads_conversation_id` FOREIGN KEY (`conversation_id`) REFERENCES `{db}`.`conversations` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Contact details collected from visitors'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- integrations: External notification channels (Telegram / WhatsApp / Email)
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`integrations` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `chatbot_id` BIGINT UNSIGNED NOT NULL,
  `integration_type` ENUM('telegram','whatsapp','email') NOT NULL,
  `status` ENUM('disconnected','pending_verification','connected','error') NOT NULL DEFAULT 'disconnected',
  `display_name` VARCHAR(150) NULL DEFAULT NULL,
  `config` JSON NULL DEFAULT NULL COMMENT 'NON-secret settings: chat_id, phone_number_id, from address...',
  `credentials_encrypted` TEXT NULL COMMENT 'AES-GCM ciphertext (bot token, API token, SMTP password). Never returned to browser',
  `encryption_key_id` VARCHAR(32) NULL DEFAULT NULL,
  `last_verified_at` DATETIME NULL DEFAULT NULL,
  `last_test_at` DATETIME NULL DEFAULT NULL,
  `last_error` VARCHAR(500) NULL DEFAULT NULL,
  `connected_at` DATETIME NULL DEFAULT NULL,
  `disconnected_at` DATETIME NULL DEFAULT NULL,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `active_flag` TINYINT(1) AS (IF(`is_deleted` = 0, 1, NULL)) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_integrations_chatbot_type` (`chatbot_id`, `integration_type`, `active_flag`),
  CONSTRAINT `fk_integrations_chatbot_id` FOREIGN KEY (`chatbot_id`) REFERENCES `{db}`.`chatbots` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='External notification channels (Telegram / WhatsApp / Email)'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- notification_preferences: Which events notify which channel (per chatbot/user)
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`notification_preferences` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `chatbot_id` BIGINT UNSIGNED NOT NULL,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `channel` ENUM('dashboard','email','telegram','whatsapp') NOT NULL,
  `event_type` ENUM('new_visitor','new_conversation','human_requested','new_message_attention','conversation_waiting','conversation_resolved','ai_unanswered','integration_error') NOT NULL,
  `is_enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `active_flag` TINYINT(1) AS (IF(`is_deleted` = 0, 1, NULL)) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_notif_prefs` (`chatbot_id`, `user_id`, `channel`, `event_type`, `active_flag`),
  CONSTRAINT `fk_notification_preferences_chatbot_id` FOREIGN KEY (`chatbot_id`) REFERENCES `{db}`.`chatbots` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_notification_preferences_user_id` FOREIGN KEY (`user_id`) REFERENCES `{db}`.`users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Which events notify which channel (per chatbot/user)'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- notifications: In-dashboard alerts
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`notifications` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `chatbot_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `conversation_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `event_type` VARCHAR(50) NOT NULL,
  `title` VARCHAR(200) NOT NULL,
  `body` VARCHAR(1000) NULL DEFAULT NULL,
  `data` JSON NULL DEFAULT NULL,
  `is_read` TINYINT(1) NOT NULL DEFAULT 0,
  `read_at` DATETIME NULL DEFAULT NULL,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_notifications_user` (`user_id`, `is_read`, `created_at`),
  KEY `idx_notifications_chatbot` (`chatbot_id`),
  CONSTRAINT `fk_notifications_user_id` FOREIGN KEY (`user_id`) REFERENCES `{db}`.`users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_notifications_chatbot_id` FOREIGN KEY (`chatbot_id`) REFERENCES `{db}`.`chatbots` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_notifications_conversation_id` FOREIGN KEY (`conversation_id`) REFERENCES `{db}`.`conversations` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='In-dashboard alerts'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- notification_deliveries: Outbound notification queue (email/Telegram/WhatsApp) with bounded retry
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`notification_deliveries` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `chatbot_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `integration_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `conversation_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `channel` ENUM('email','telegram','whatsapp') NOT NULL,
  `event_type` VARCHAR(50) NOT NULL COMMENT 'spec events or system (verify email, reset, test)',
  `recipient` VARCHAR(254) NULL DEFAULT NULL,
  `subject` VARCHAR(255) NULL DEFAULT NULL,
  `payload` JSON NULL DEFAULT NULL,
  `dedupe_key` VARCHAR(128) NULL DEFAULT NULL COMMENT 'avoid duplicate sends across channels/retries',
  `status` ENUM('pending','sending','sent','failed','skipped','dead') NOT NULL DEFAULT 'pending',
  `attempt_count` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `max_attempts` TINYINT UNSIGNED NOT NULL DEFAULT 5,
  `next_attempt_at` DATETIME NULL DEFAULT NULL,
  `last_attempt_at` DATETIME NULL DEFAULT NULL,
  `sent_at` DATETIME NULL DEFAULT NULL,
  `provider_message_id` VARCHAR(150) NULL DEFAULT NULL,
  `last_error` VARCHAR(500) NULL DEFAULT NULL,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_deliveries_dedupe` (`dedupe_key`),
  KEY `idx_deliveries_queue` (`status`, `next_attempt_at`),
  KEY `idx_deliveries_chatbot` (`chatbot_id`, `created_at`),
  CONSTRAINT `fk_notification_deliveries_chatbot_id` FOREIGN KEY (`chatbot_id`) REFERENCES `{db}`.`chatbots` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_notification_deliveries_integration_id` FOREIGN KEY (`integration_id`) REFERENCES `{db}`.`integrations` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_notification_deliveries_user_id` FOREIGN KEY (`user_id`) REFERENCES `{db}`.`users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_notification_deliveries_conversation_id` FOREIGN KEY (`conversation_id`) REFERENCES `{db}`.`conversations` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Outbound notification queue (email/Telegram/WhatsApp) with bounded retry'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- notification_delivery_attempts: Every delivery attempt and failure
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`notification_delivery_attempts` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `delivery_id` BIGINT UNSIGNED NOT NULL,
  `attempt_number` TINYINT UNSIGNED NOT NULL,
  `success` TINYINT(1) NOT NULL DEFAULT 0,
  `http_status` SMALLINT UNSIGNED NULL DEFAULT NULL,
  `error_message` VARCHAR(500) NULL DEFAULT NULL,
  `duration_ms` INT UNSIGNED NULL DEFAULT NULL,
  `attempted_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_attempts_delivery` (`delivery_id`),
  CONSTRAINT `fk_notification_delivery_attempts_delivery_id` FOREIGN KEY (`delivery_id`) REFERENCES `{db}`.`notification_deliveries` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Every delivery attempt and failure'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- analytics_daily: Daily rollup per chatbot for dashboard charts (rebuilt by a cron job)
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`analytics_daily` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `chatbot_id` BIGINT UNSIGNED NOT NULL,
  `stat_date` DATE NOT NULL,
  `new_visitors` INT UNSIGNED NOT NULL DEFAULT 0,
  `returning_visitors` INT UNSIGNED NOT NULL DEFAULT 0,
  `conversations_started` INT UNSIGNED NOT NULL DEFAULT 0,
  `conversations_resolved_ai` INT UNSIGNED NOT NULL DEFAULT 0,
  `human_handovers` INT UNSIGNED NOT NULL DEFAULT 0,
  `handover_requests` INT UNSIGNED NOT NULL DEFAULT 0,
  `unanswered_questions` INT UNSIGNED NOT NULL DEFAULT 0,
  `messages_total` INT UNSIGNED NOT NULL DEFAULT 0,
  `messages_visitor` INT UNSIGNED NOT NULL DEFAULT 0,
  `messages_ai` INT UNSIGNED NOT NULL DEFAULT 0,
  `messages_human` INT UNSIGNED NOT NULL DEFAULT 0,
  `faq_answers` INT UNSIGNED NOT NULL DEFAULT 0,
  `ai_answers` INT UNSIGNED NOT NULL DEFAULT 0,
  `eligible_conversations` INT UNSIGNED NOT NULL DEFAULT 0,
  `responded_conversations` INT UNSIGNED NOT NULL DEFAULT 0,
  `avg_first_response_ms` INT UNSIGNED NULL DEFAULT NULL,
  `ai_prompt_tokens` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `ai_completion_tokens` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_analytics_day` (`chatbot_id`, `stat_date`),
  CONSTRAINT `fk_analytics_daily_chatbot_id` FOREIGN KEY (`chatbot_id`) REFERENCES `{db}`.`chatbots` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Daily rollup per chatbot for dashboard charts (rebuilt by a cron job)'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- data_deletion_requests: Visitor/chatbot/account deletion requests and AI-service cleanup status
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`data_deletion_requests` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `request_type` ENUM('visitor_data','chatbot','account') NOT NULL,
  `user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `chatbot_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `visitor_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `chatbot_public_id` VARCHAR(40) NULL DEFAULT NULL COMMENT 'kept so the AI-service delete can be retried after the row is purged',
  `status` ENUM('pending','in_progress','completed','failed') NOT NULL DEFAULT 'pending',
  `ai_service_deleted_at` DATETIME NULL DEFAULT NULL,
  `attempts` INT UNSIGNED NOT NULL DEFAULT 0,
  `last_error` VARCHAR(500) NULL DEFAULT NULL,
  `requested_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `completed_at` DATETIME NULL DEFAULT NULL,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_deletion_status` (`status`, `request_type`),
  CONSTRAINT `fk_data_deletion_requests_user_id` FOREIGN KEY (`user_id`) REFERENCES `{db}`.`users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_data_deletion_requests_chatbot_id` FOREIGN KEY (`chatbot_id`) REFERENCES `{db}`.`chatbots` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_data_deletion_requests_visitor_id` FOREIGN KEY (`visitor_id`) REFERENCES `{db}`.`visitors` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Visitor/chatbot/account deletion requests and AI-service cleanup status'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- audit_logs: Security and administrative audit trail (never store secrets or passwords)
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`audit_logs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `actor_type` ENUM('user','agent','admin','system','visitor','api_key') NOT NULL DEFAULT 'user',
  `user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `chatbot_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `action` VARCHAR(100) NOT NULL COMMENT 'e.g. auth.login, chatbot.create, conversation.takeover',
  `entity_type` VARCHAR(60) NULL DEFAULT NULL,
  `entity_id` VARCHAR(64) NULL DEFAULT NULL,
  `outcome` ENUM('success','failure','denied') NOT NULL DEFAULT 'success',
  `old_values` JSON NULL DEFAULT NULL,
  `new_values` JSON NULL DEFAULT NULL,
  `metadata` JSON NULL DEFAULT NULL,
  `ip_address` VARCHAR(45) NULL DEFAULT NULL,
  `user_agent` VARCHAR(500) NULL DEFAULT NULL,
  `request_id` VARCHAR(64) NULL DEFAULT NULL,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_audit_user` (`user_id`, `created_at`),
  KEY `idx_audit_chatbot` (`chatbot_id`, `created_at`),
  KEY `idx_audit_action` (`action`, `created_at`),
  KEY `idx_audit_entity` (`entity_type`, `entity_id`),
  CONSTRAINT `fk_audit_logs_user_id` FOREIGN KEY (`user_id`) REFERENCES `{db}`.`users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_audit_logs_chatbot_id` FOREIGN KEY (`chatbot_id`) REFERENCES `{db}`.`chatbots` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Security and administrative audit trail (never store secrets or passwords)'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- platform_settings: Runtime-tunable platform settings (key/value)
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`platform_settings` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `setting_key` VARCHAR(100) NOT NULL,
  `setting_value` VARCHAR(1000) NOT NULL,
  `description` VARCHAR(255) NULL DEFAULT NULL,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_platform_settings_key` (`setting_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Runtime-tunable platform settings (key/value)'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- schema_migrations: Applied schema versions
SET @q = REPLACE("CREATE TABLE IF NOT EXISTS `{db}`.`schema_migrations` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `version` VARCHAR(30) NOT NULL,
  `description` VARCHAR(255) NULL DEFAULT NULL,
  `applied_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `is_deleted` TINYINT(1) NOT NULL DEFAULT 0,
  `deleted_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_schema_version` (`version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Applied schema versions'", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- foreign keys that point forward (added after all tables exist; skipped if already present)
SET @q = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = @db_name AND TABLE_NAME = 'users' AND CONSTRAINT_NAME = 'fk_users_profile_picture') = 0,
  REPLACE("ALTER TABLE `{db}`.`users` ADD CONSTRAINT `fk_users_profile_picture` FOREIGN KEY (`profile_picture_file_id`) REFERENCES `{db}`.`uploaded_files` (`id`) ON DELETE SET NULL ON UPDATE CASCADE", '{db}', @db_name), 'DO 0'); PREPARE st FROM @q; EXECUTE st;
SET @q = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = @db_name AND TABLE_NAME = 'uploaded_files' AND CONSTRAINT_NAME = 'fk_uploaded_files_chatbot') = 0,
  REPLACE("ALTER TABLE `{db}`.`uploaded_files` ADD CONSTRAINT `fk_uploaded_files_chatbot` FOREIGN KEY (`chatbot_id`) REFERENCES `{db}`.`chatbots` (`id`) ON DELETE SET NULL ON UPDATE CASCADE", '{db}', @db_name), 'DO 0'); PREPARE st FROM @q; EXECUTE st;
SET @q = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = @db_name AND TABLE_NAME = 'api_keys' AND CONSTRAINT_NAME = 'fk_api_keys_chatbot') = 0,
  REPLACE("ALTER TABLE `{db}`.`api_keys` ADD CONSTRAINT `fk_api_keys_chatbot` FOREIGN KEY (`chatbot_id`) REFERENCES `{db}`.`chatbots` (`id`) ON DELETE SET NULL ON UPDATE CASCADE", '{db}', @db_name), 'DO 0'); PREPARE st FROM @q; EXECUTE st;
SET @q = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = @db_name AND TABLE_NAME = 'chatbots' AND CONSTRAINT_NAME = 'fk_chatbots_last_job') = 0,
  REPLACE("ALTER TABLE `{db}`.`chatbots` ADD CONSTRAINT `fk_chatbots_last_job` FOREIGN KEY (`last_training_job_id`) REFERENCES `{db}`.`training_jobs` (`id`) ON DELETE SET NULL ON UPDATE CASCADE", '{db}', @db_name), 'DO 0'); PREPARE st FROM @q; EXECUTE st;
SET @q = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = @db_name AND TABLE_NAME = 'chatbot_appearance' AND CONSTRAINT_NAME = 'fk_appearance_logo') = 0,
  REPLACE("ALTER TABLE `{db}`.`chatbot_appearance` ADD CONSTRAINT `fk_appearance_logo` FOREIGN KEY (`logo_file_id`) REFERENCES `{db}`.`uploaded_files` (`id`) ON DELETE SET NULL ON UPDATE CASCADE", '{db}', @db_name), 'DO 0'); PREPARE st FROM @q; EXECUTE st;
SET @q = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = @db_name AND TABLE_NAME = 'chatbot_appearance' AND CONSTRAINT_NAME = 'fk_appearance_avatar') = 0,
  REPLACE("ALTER TABLE `{db}`.`chatbot_appearance` ADD CONSTRAINT `fk_appearance_avatar` FOREIGN KEY (`avatar_file_id`) REFERENCES `{db}`.`uploaded_files` (`id`) ON DELETE SET NULL ON UPDATE CASCADE", '{db}', @db_name), 'DO 0'); PREPARE st FROM @q; EXECUTE st;
SET @q = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = @db_name AND TABLE_NAME = 'chatbot_appearance' AND CONSTRAINT_NAME = 'fk_appearance_launcher') = 0,
  REPLACE("ALTER TABLE `{db}`.`chatbot_appearance` ADD CONSTRAINT `fk_appearance_launcher` FOREIGN KEY (`launcher_icon_file_id`) REFERENCES `{db}`.`uploaded_files` (`id`) ON DELETE SET NULL ON UPDATE CASCADE", '{db}', @db_name), 'DO 0'); PREPARE st FROM @q; EXECUTE st;
SET @q = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = @db_name AND TABLE_NAME = 'announcements' AND CONSTRAINT_NAME = 'fk_announcements_image') = 0,
  REPLACE("ALTER TABLE `{db}`.`announcements` ADD CONSTRAINT `fk_announcements_image` FOREIGN KEY (`image_file_id`) REFERENCES `{db}`.`uploaded_files` (`id`) ON DELETE SET NULL ON UPDATE CASCADE", '{db}', @db_name), 'DO 0'); PREPARE st FROM @q; EXECUTE st;

-- ---- seed data
SET @q = REPLACE("INSERT INTO `{db}`.`widget_templates` (`template_key`,`name`,`description`,`default_config`,`sort_order`) VALUES ('modern_minimal','Modern Minimal','Clean layout, restrained colors, subtle borders, lightweight professional look.','{\"theme\":\"light\",\"primary_color\":\"#1F3A5F\",\"secondary_color\":\"#4A6FA5\",\"border_radius\":12,\"shadow\":\"soft\",\"message_style\":\"flat\",\"launcher_animation\":\"none\"}',1) ON DUPLICATE KEY UPDATE `template_key` = `template_key`", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;
SET @q = REPLACE("INSERT INTO `{db}`.`widget_templates` (`template_key`,`name`,`description`,`default_config`,`sort_order`) VALUES ('modern_gradient','Modern Gradient','Contemporary gradients, expressive accents, smooth but restrained animations.','{\"theme\":\"light\",\"primary_color\":\"#6366F1\",\"secondary_color\":\"#EC4899\",\"gradient_css\":\"linear-gradient(135deg,#6366F1,#EC4899)\",\"border_radius\":20,\"shadow\":\"strong\",\"message_style\":\"bubbles\",\"launcher_animation\":\"pulse\"}',2) ON DUPLICATE KEY UPDATE `template_key` = `template_key`", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;
SET @q = REPLACE("INSERT INTO `{db}`.`widget_templates` (`template_key`,`name`,`description`,`default_config`,`sort_order`) VALUES ('professional_support','Professional Support','Business-focused support layout with clear hierarchy, readable messages and strong usability.','{\"theme\":\"light\",\"primary_color\":\"#0F766E\",\"secondary_color\":\"#134E4A\",\"border_radius\":8,\"shadow\":\"medium\",\"message_style\":\"cards\",\"launcher_animation\":\"none\",\"spacing\":\"comfortable\"}',3) ON DUPLICATE KEY UPDATE `template_key` = `template_key`", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;
SET @q = REPLACE("INSERT INTO `{db}`.`widget_versions` (`version`,`channel`,`is_default`,`release_notes`,`released_at`) VALUES ('1.0.0','stable',1,'Initial release',UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE `version` = `version`", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;
SET @q = REPLACE("INSERT INTO `{db}`.`platform_settings` (`setting_key`,`setting_value`,`description`) VALUES ('max_domains_per_chatbot','3','Allowed domains per chatbot (users.domain_limit_override wins)') ON DUPLICATE KEY UPDATE `setting_key` = `setting_key`", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;
SET @q = REPLACE("INSERT INTO `{db}`.`platform_settings` (`setting_key`,`setting_value`,`description`) VALUES ('max_chatbots_per_user','1','Fallback if env MAX_CHATBOTS_PER_USER is not set (users.chatbot_limit_override wins)') ON DUPLICATE KEY UPDATE `setting_key` = `setting_key`", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;
SET @q = REPLACE("INSERT INTO `{db}`.`platform_settings` (`setting_key`,`setting_value`,`description`) VALUES ('email_verification_required','1','1 = users must verify email before login') ON DUPLICATE KEY UPDATE `setting_key` = `setting_key`", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;
SET @q = REPLACE("INSERT INTO `{db}`.`platform_settings` (`setting_key`,`setting_value`,`description`) VALUES ('access_token_ttl_seconds','900','Short-lived access token lifetime') ON DUPLICATE KEY UPDATE `setting_key` = `setting_key`", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;
SET @q = REPLACE("INSERT INTO `{db}`.`platform_settings` (`setting_key`,`setting_value`,`description`) VALUES ('refresh_token_ttl_days','30','Refresh session lifetime') ON DUPLICATE KEY UPDATE `setting_key` = `setting_key`", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;
SET @q = REPLACE("INSERT INTO `{db}`.`platform_settings` (`setting_key`,`setting_value`,`description`) VALUES ('password_reset_ttl_minutes','60','Password reset link lifetime') ON DUPLICATE KEY UPDATE `setting_key` = `setting_key`", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;
SET @q = REPLACE("INSERT INTO `{db}`.`platform_settings` (`setting_key`,`setting_value`,`description`) VALUES ('email_verification_ttl_hours','24','Verification link lifetime') ON DUPLICATE KEY UPDATE `setting_key` = `setting_key`", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;
SET @q = REPLACE("INSERT INTO `{db}`.`platform_settings` (`setting_key`,`setting_value`,`description`) VALUES ('max_login_failures','5','Failed logins before lockout') ON DUPLICATE KEY UPDATE `setting_key` = `setting_key`", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;
SET @q = REPLACE("INSERT INTO `{db}`.`platform_settings` (`setting_key`,`setting_value`,`description`) VALUES ('lockout_minutes','15','Lockout duration') ON DUPLICATE KEY UPDATE `setting_key` = `setting_key`", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;
SET @q = REPLACE("INSERT INTO `{db}`.`platform_settings` (`setting_key`,`setting_value`,`description`) VALUES ('installation_inactive_after_hours','72','Mark installation inactive when widget not seen for this long') ON DUPLICATE KEY UPDATE `setting_key` = `setting_key`", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;
SET @q = REPLACE("INSERT INTO `{db}`.`platform_settings` (`setting_key`,`setting_value`,`description`) VALUES ('crawl_max_pages_default','500','Default max pages per crawl sent to the AI service') ON DUPLICATE KEY UPDATE `setting_key` = `setting_key`", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;
SET @q = REPLACE("INSERT INTO `{db}`.`schema_migrations` (`version`,`description`) VALUES ('1.0.0','Initial schema') ON DUPLICATE KEY UPDATE `version` = `version`", '{db}', @db_name); PREPARE st FROM @q; EXECUTE st;

-- ---- optional application user
SET @q = IF(@create_app_user = 1,
  CONCAT('CREATE USER IF NOT EXISTS ''', @app_user, '''@''', @app_host, ''' IDENTIFIED BY ''', REPLACE(@app_password, '''', ''''''), ''''), 'DO 0');
PREPARE st FROM @q; EXECUTE st;
SET @q = IF(@create_app_user = 1,
  CONCAT('GRANT SELECT, INSERT, UPDATE, DELETE ON `', @db_name, '`.* TO ''', @app_user, '''@''', @app_host, ''''), 'DO 0');
PREPARE st FROM @q; EXECUTE st;

DEALLOCATE PREPARE st;
SET FOREIGN_KEY_CHECKS = @OLD_FK;

-- ---- done: list the tables
SET @q = CONCAT('SELECT TABLE_NAME, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ''', @db_name, ''' ORDER BY TABLE_NAME');
PREPARE st FROM @q; EXECUTE st; DEALLOCATE PREPARE st;
