-- Schema only, generated from the empty pinned CPAMP 1ae656c fixture. No installation data.
CREATE TABLE account_action_candidates (
			id integer primary key autoincrement,
			action_type text not null,
			status text not null,
			provider text,
			auth_file_name text not null,
			auth_index text,
			account_snapshot text,
			account_id_snapshot text,
			auth_label text,
			reason_code text,
			reason text,
			auto_disable_eligible integer not null default 0,
			auto_disabled_at_ms integer,
			evidence_json text,
			last_error text,
			first_seen_at_ms integer not null,
			last_seen_at_ms integer not null,
			hit_count integer not null default 1,
			created_at_ms integer not null,
			updated_at_ms integer not null
		);

CREATE TABLE account_quota_cycles (
			id integer primary key autoincrement,
			activation_id integer not null,
			provider_cycle_key text not null,
			state text not null,
			scheduled_start_ms integer,
			scheduled_end_ms integer,
			actual_start_ms integer not null,
			actual_end_ms integer,
			duration_seconds integer,
			boundary_accuracy text not null,
			end_reason text,
			first_observation_id integer,
			last_observation_id integer,
			parent_cycle_id integer,
			created_at_ms integer not null,
			updated_at_ms integer not null,
			unique(activation_id, provider_cycle_key),
			foreign key(activation_id) references account_quota_window_activations(id),
			foreign key(first_observation_id) references account_quota_observations(id),
			foreign key(last_observation_id) references account_quota_observations(id),
			foreign key(parent_cycle_id) references account_quota_cycles(id)
		);

CREATE TABLE account_quota_observations (
			id integer primary key autoincrement,
			observation_hash text not null unique,
			account_key text not null,
			provider text not null,
			source text not null,
			source_observation_id text,
			inventory_scope_key text not null,
			inventory_mode text not null,
			observed_at_ms integer not null,
			window_count integer not null default 0,
			lifecycle_applied integer not null default 1,
			created_at_ms integer not null
		);

CREATE TABLE account_quota_snapshots (
			id integer primary key autoincrement,
			observation_id integer,
			logical_window_id integer,
			activation_id integer,
			cycle_id integer,
			account_key text not null,
			provider text not null,
			provider_window_id text not null,
			window_kind text not null,
			window_mode text not null,
			model_scope_kind text not null,
			model_scope_key text,
			model_ids_json text,
			scope_fingerprint text not null default '',
			content_hash text not null default '',
			source text not null,
			source_observation_id text,
			observed_at_ms integer not null,
			boundary_accuracy text not null,
			cycle_start_ms integer,
			cycle_end_ms integer,
			duration_seconds integer,
			used_percent real,
			remaining_percent real,
			used_value real,
			limit_value real,
			quota_unit text,
			reset_credits_available integer,
			reset_credits_json text,
			plan_type text,
			created_at_ms integer not null
		);

CREATE TABLE account_quota_window_activations (
			id integer primary key autoincrement,
			window_id integer not null,
			generation integer not null,
			status text not null,
			activated_at_ms integer not null,
			deactivated_at_ms integer,
			activation_accuracy text not null,
			deactivation_reason text,
			activate_observation_id integer,
			deactivate_observation_id integer,
			created_at_ms integer not null,
			updated_at_ms integer not null,
			unique(window_id, generation),
			foreign key(window_id) references account_quota_windows(id),
			foreign key(activate_observation_id) references account_quota_observations(id),
			foreign key(deactivate_observation_id) references account_quota_observations(id)
		);

CREATE TABLE account_quota_windows (
			id integer primary key autoincrement,
			account_key text not null,
			provider text not null,
			provider_window_id text not null,
			window_kind text not null,
			window_mode text not null,
			model_scope_kind text not null,
			model_scope_key text,
			model_ids_json text,
			scope_fingerprint text not null,
			inventory_scope_key text not null,
			relationship_kind text,
			container_provider_window_id text,
			availability text not null,
			generation integer not null default 1,
			absence_count integer not null default 0,
			first_seen_at_ms integer not null,
			last_seen_at_ms integer not null,
			missing_since_ms integer,
			deactivated_at_ms integer,
			last_observation_id integer,
			created_at_ms integer not null,
			updated_at_ms integer not null,
			unique(account_key, provider, provider_window_id, scope_fingerprint),
			foreign key(last_observation_id) references account_quota_observations(id)
		);

CREATE TABLE api_key_aliases (
			api_key_hash text primary key,
			alias text not null,
			updated_at_ms integer not null
		);

CREATE TABLE codex_inspection_disable_ownership (
			file_name text not null,
			provider text not null default '',
			auth_index text not null default '',
			account_id text not null default '',
			account_snapshot text not null default '',
			disabled_at_ms integer not null,
			updated_at_ms integer not null,
			primary key (file_name, provider, auth_index, account_id, account_snapshot)
		);

CREATE TABLE codex_inspection_leases (
			id integer primary key check (id = 1),
			run_id integer,
			owner_id text not null,
			heartbeat_at_ms integer not null,
			lease_expires_at_ms integer not null,
			foreign key(run_id) references codex_inspection_runs(id) on delete set null
		);

CREATE TABLE codex_inspection_logs (
			id integer primary key autoincrement,
			run_id integer not null,
			level text not null,
			message text not null,
			detail_json text,
			created_at_ms integer not null,
			foreign key(run_id) references codex_inspection_runs(id) on delete cascade
		);

CREATE TABLE codex_inspection_results (
			id integer primary key autoincrement,
			run_id integer not null,
			account_key text not null,
			file_name text not null,
			display_account text not null,
			account_snapshot text,
			auth_index text,
			account_id text,
			provider text,
			disabled integer not null default 0,
			status text,
			state text,
			action text not null,
			action_reason text,
			action_status text,
			executed_action text,
			action_error text,
			status_code integer,
			used_percent real,
			is_quota integer not null default 0,
			auto_recover_eligible integer not null default 0,
			error text,
			plan_type text,
			quota_windows_json text,
			error_kind text,
			error_detail text,
			created_at_ms integer not null,
			foreign key(run_id) references codex_inspection_runs(id) on delete cascade,
			unique(run_id, account_key)
		);

CREATE TABLE codex_inspection_runs (
			id integer primary key autoincrement,
			trigger_type text not null,
			trigger_key text,
			status text not null,
			started_at_ms integer not null,
			finished_at_ms integer,
			total_files integer not null default 0,
			probe_set_count integer not null default 0,
			sampled_count integer not null default 0,
			disabled_count integer not null default 0,
			enabled_count integer not null default 0,
			delete_count integer not null default 0,
			disable_count integer not null default 0,
			enable_count integer not null default 0,
			reauth_count integer not null default 0,
			keep_count integer not null default 0,
			error text,
			settings_json text not null,
			created_at_ms integer not null,
			updated_at_ms integer not null
		);

CREATE TABLE dead_letter_events (
			id integer primary key autoincrement,
			payload text not null,
			error text not null,
			created_at_ms integer not null
		);

CREATE TABLE model_price_context_tiers (
			model text not null,
			threshold_tokens integer not null,
			prompt_per_1m real not null default 0,
			completion_per_1m real not null default 0,
			cache_per_1m real not null default 0,
			cache_read_per_1m real not null default 0,
			cache_creation_per_1m real not null default 0,
			prompt_configured integer not null default 0,
			completion_configured integer not null default 0,
			cache_configured integer not null default 0,
			cache_read_configured integer not null default 0,
			cache_creation_configured integer not null default 0,
			primary key (model, threshold_tokens),
			foreign key (model) references model_prices(model) on delete cascade
		);

CREATE TABLE model_price_service_tiers (
			model text not null,
			mode text not null,
			service_tier text not null,
			prompt_per_1m real not null default 0,
			completion_per_1m real not null default 0,
			cache_per_1m real not null default 0,
			cache_read_per_1m real not null default 0,
			cache_creation_per_1m real not null default 0,
			prompt_configured integer not null default 0,
			completion_configured integer not null default 0,
			cache_configured integer not null default 0,
			cache_read_configured integer not null default 0,
			cache_creation_configured integer not null default 0,
			primary key (model, mode, service_tier),
			foreign key (model) references model_prices(model) on delete cascade
		);

CREATE TABLE model_prices (
			model text primary key,
			prompt_per_1m real not null,
			completion_per_1m real not null,
			cache_per_1m real not null,
			cache_read_per_1m real not null default 0,
			cache_creation_per_1m real not null default 0,
			prompt_configured integer not null default 0,
			completion_configured integer not null default 0,
			cache_read_configured integer not null default 0,
			cache_creation_configured integer not null default 0,
			source text,
			source_model_id text,
			raw_json text,
			updated_at_ms integer not null,
			synced_at_ms integer
		);

CREATE TABLE quota_cooldowns (
			id integer primary key autoincrement,
			auth_file_name text not null,
			auth_index text,
			account_snapshot text,
			provider text,
			reason_code text,
			window_kind text,
			evidence_json text,
			recover_at_ms integer not null,
			owner text not null,
			event_hash text,
			pre_disabled_state integer not null default 0,
			status text not null,
			disabled_at_ms integer not null,
			recovered_at_ms integer,
			last_error text,
			created_at_ms integer not null,
			updated_at_ms integer not null
		);

CREATE TABLE settings (
			key text primary key,
			value text not null,
			updated_at_ms integer not null
		);

CREATE TABLE usage_account_model_rollups (
		account_key text not null,
		account_snapshot text,
		auth_label_snapshot text,
		auth_provider_snapshot text,
		auth_index text,
		source text,
		source_hash text,
		model text not null,
		billing_model text not null,
		service_tier text not null,
		calls integer not null default 0,
		success_calls integer not null default 0,
		failure_calls integer not null default 0,
		input_tokens integer not null default 0,
		output_tokens integer not null default 0,
		reasoning_tokens integer not null default 0,
		cached_tokens integer not null default 0,
		cache_read_tokens integer not null default 0,
		cache_creation_tokens integer not null default 0,
		long_input_tokens integer not null default 0,
		long_output_tokens integer not null default 0,
		long_cached_tokens integer not null default 0,
		long_cache_read_tokens integer not null default 0,
		long_cache_creation_tokens integer not null default 0,
		total_tokens integer not null default 0,
		first_seen_ms integer not null,
		last_seen_ms integer not null,
		updated_at_ms integer not null,
		primary key (account_key, model, billing_model, service_tier)
	);

CREATE TABLE usage_cache_accounting_v2_changes (
			event_id integer primary key,
			cache_input_mode text not null,
			normalized_uncached_input_tokens integer not null,
			normalized_total_input_tokens integer not null,
			normalized_cache_read_tokens integer not null,
			normalized_cache_creation_tokens integer not null,
			total_tokens integer not null
		);

CREATE TABLE usage_codex_legacy_identity_evidence_v1 (
		structure_revision text not null,
		physical_kind integer not null,
		physical_file text collate nocase not null,
		auth_index text collate nocase not null,
		provider text not null,
		auth_provider_snapshot text not null,
		auth_account_id_snapshot text not null,
		auth_project_id_snapshot text not null,
		account_snapshot text not null,
		min_evidence_at_ms integer not null,
		max_evidence_at_ms integer not null,
		chronology_unknown integer not null,
		primary key (
			structure_revision, physical_kind, physical_file, auth_index,
			provider, auth_provider_snapshot, auth_account_id_snapshot,
			auth_project_id_snapshot, account_snapshot
		)
	);

CREATE TABLE usage_dashboard_hourly_rollups (
		bucket_ms integer not null,
		model text not null,
		billing_model text not null,
		service_tier text not null,
		calls integer not null default 0,
		success_calls integer not null default 0,
		failure_calls integer not null default 0,
		input_tokens integer not null default 0,
		output_tokens integer not null default 0,
		reasoning_tokens integer not null default 0,
		cached_tokens integer not null default 0,
		cache_read_tokens integer not null default 0,
		cache_creation_tokens integer not null default 0,
		long_input_tokens integer not null default 0,
		long_output_tokens integer not null default 0,
		long_cached_tokens integer not null default 0,
		long_cache_read_tokens integer not null default 0,
		long_cache_creation_tokens integer not null default 0,
		total_tokens integer not null default 0,
		latency_sum_ms integer not null default 0,
		latency_samples integer not null default 0,
		zero_token_calls integer not null default 0,
		updated_at_ms integer not null,
		primary key (bucket_ms, model, billing_model, service_tier)
	);

CREATE TABLE usage_data_migrations (
			name text primary key,
			status text not null,
			last_event_id integer not null default 0,
			target_event_id integer not null default 0,
			processed_rows integer not null default 0,
			changed_rows integer not null default 0,
			applied_rows integer not null default 0,
			started_at_ms integer,
			updated_at_ms integer not null default 0,
			finished_at_ms integer,
			last_error text
		);

CREATE TABLE usage_derived_cleanup_cursors (
		target_name text primary key,
		table_name text not null,
		revision_token text not null,
		last_rowid integer not null default 0,
		updated_at_ms integer not null default 0
	);

CREATE TABLE usage_derived_cleanup_jobs (
		id integer primary key autoincrement,
		generation integer not null unique,
		kind text not null,
		status text not null,
		projection_table text,
		fts_table text not null unique,
		processed_rows integer not null default 0,
		created_at_ms integer not null,
		updated_at_ms integer not null,
		finished_at_ms integer,
		last_error text
	);

CREATE TABLE usage_derived_deferred_indexes (
		index_name text primary key,
		table_name text not null,
		reason text not null,
		created_at_ms integer not null,
		updated_at_ms integer not null
	);

CREATE TABLE usage_event_identity_ledger (
			event_hash text primary key,
			raw_event_id integer,
			timestamp_ms integer not null,
			bucket_ms integer not null,
			aggregate_schema_version integer not null default 0,
			aggregate_structure_revision text not null default '',
			first_seen_at_ms integer not null,
			updated_at_ms integer not null
		);

CREATE TABLE usage_events (
			id integer primary key autoincrement,
			request_id text,
			event_hash text not null unique,
			timestamp_ms integer not null,
			timestamp text not null,
			provider text,
			executor_type text,
			model text not null,
			endpoint text,
			method text,
			path text,
			client_ip text,
			x_forwarded_for text,
			user_agent text,
			auth_type text,
			auth_index text,
			source text,
			source_hash text,
			api_key_hash text,
			account_snapshot text,
			auth_label_snapshot text,
			auth_file_snapshot text,
			auth_provider_snapshot text,
			auth_account_id_snapshot text,
			auth_project_id_snapshot text,
			auth_snapshot_at_ms integer,
			requested_model text,
			resolved_model text,
			reasoning_effort text,
			service_tier text,
			request_service_tier text,
			response_service_tier text,
			cache_input_mode text,
			input_tokens integer not null default 0,
			output_tokens integer not null default 0,
			reasoning_tokens integer not null default 0,
			cached_tokens integer not null default 0,
			cache_tokens integer not null default 0,
			cache_read_tokens integer not null default 0,
			cache_creation_tokens integer not null default 0,
			normalized_uncached_input_tokens integer,
			normalized_total_input_tokens integer,
			normalized_cache_read_tokens integer,
			normalized_cache_creation_tokens integer,
			total_tokens integer not null default 0,
			latency_ms integer,
			ttft_ms integer,
			failed integer not null default 0,
			fail_status_code integer,
			fail_summary text,
			response_metadata_json text,
			header_quota_recover_at_ms integer,
			header_quota_used_percent real,
			header_quota_plan_type text,
			header_error_kind text,
			header_error_code text,
			header_trace_id text,
			fail_body text,
			raw_json text,
			created_at_ms integer not null
		);

CREATE TABLE usage_hourly_aggregate_state (
			aggregate_name text primary key,
			schema_version integer not null,
			structure_revision text not null default '',
			status text not null,
			backfill_last_event_id integer not null default 0,
			coverage_event_id integer not null default 0,
			target_event_id integer not null default 0,
			processed_events integer not null default 0,
			min_bucket_ms integer,
			max_bucket_ms integer,
			last_run_started_at_ms integer,
			updated_at_ms integer not null default 0,
			finished_at_ms integer,
			last_error text
		);

CREATE TABLE usage_hourly_aggregate_v1 (
		bucket_ms integer not null,
		model text not null,
		billing_model text not null,
		service_tier text not null,
		failed integer not null,
		calls integer not null default 0,
		input_tokens integer not null default 0,
		output_tokens integer not null default 0,
		reasoning_tokens integer not null default 0,
		cached_tokens integer not null default 0,
		cache_read_tokens integer not null default 0,
		cache_creation_tokens integer not null default 0,
		long_input_tokens integer not null default 0,
		long_output_tokens integer not null default 0,
		long_cached_tokens integer not null default 0,
		long_cache_read_tokens integer not null default 0,
		long_cache_creation_tokens integer not null default 0,
		total_tokens integer not null default 0,
		latency_sum_ms integer not null default 0,
		latency_samples integer not null default 0,
		zero_token_calls integer not null default 0,
		updated_at_ms integer not null,
		primary key (bucket_ms, model, billing_model, service_tier, failed)
	);

CREATE TABLE usage_monitoring_account_daily_rollups_v1 (
			structure_revision text not null,
			bucket_ms integer not null,
			account_snapshot text not null,
			auth_label_snapshot text not null,
			provider text not null,
			auth_provider_snapshot text not null,
			auth_account_id_snapshot text not null default '',
			auth_index text not null,
			source text not null,
			source_hash text not null,
			auth_file_snapshot text not null,
			api_key_hash text not null,
			executor_type text not null,
			model text not null,
			billing_model text not null,
			pricing_model text not null,
			service_tier text not null,
			context_threshold_tokens integer not null,
			failed integer not null,
			calls integer not null default 0,
			input_tokens integer not null default 0,
			output_tokens integer not null default 0,
			reasoning_tokens integer not null default 0,
			cached_tokens integer not null default 0,
			cache_read_tokens integer not null default 0,
			cache_creation_tokens integer not null default 0,
			long_input_tokens integer not null default 0,
			long_output_tokens integer not null default 0,
			long_cached_tokens integer not null default 0,
			long_cache_read_tokens integer not null default 0,
			long_cache_creation_tokens integer not null default 0,
			total_tokens integer not null default 0,
			zero_token_calls integer not null default 0,
			latency_sum_ms integer not null default 0,
			latency_samples integer not null default 0,
			last_seen_ms integer not null,
			updated_at_ms integer not null,
			primary key (
				structure_revision, bucket_ms, account_snapshot, auth_label_snapshot,
				provider, auth_provider_snapshot, auth_account_id_snapshot, auth_index, source, source_hash,
				auth_file_snapshot, api_key_hash, executor_type, model, billing_model,
				pricing_model, service_tier, context_threshold_tokens, failed
			)
		);

CREATE TABLE usage_monitoring_api_key_daily_rollups_v1 (
			structure_revision text not null,
			bucket_ms integer not null,
			api_key_hash text not null,
			account_snapshot text not null,
			auth_label_snapshot text not null,
			provider text not null,
			auth_provider_snapshot text not null,
			auth_account_id_snapshot text not null default '',
			auth_index text not null,
			source text not null,
			source_hash text not null,
			auth_file_snapshot text not null,
			executor_type text not null,
			model text not null,
			billing_model text not null,
			pricing_model text not null,
			service_tier text not null,
			context_threshold_tokens integer not null,
			failed integer not null,
			calls integer not null default 0,
			input_tokens integer not null default 0,
			output_tokens integer not null default 0,
			reasoning_tokens integer not null default 0,
			cached_tokens integer not null default 0,
			cache_read_tokens integer not null default 0,
			cache_creation_tokens integer not null default 0,
			long_input_tokens integer not null default 0,
			long_output_tokens integer not null default 0,
			long_cached_tokens integer not null default 0,
			long_cache_read_tokens integer not null default 0,
			long_cache_creation_tokens integer not null default 0,
			total_tokens integer not null default 0,
			zero_token_calls integer not null default 0,
			latency_sum_ms integer not null default 0,
			latency_samples integer not null default 0,
			last_seen_ms integer not null,
			updated_at_ms integer not null,
			primary key (
				structure_revision, bucket_ms, api_key_hash, account_snapshot,
				auth_label_snapshot, provider, auth_provider_snapshot, auth_account_id_snapshot, auth_index,
				source, source_hash, auth_file_snapshot, executor_type, model,
				billing_model, pricing_model, service_tier,
				context_threshold_tokens, failed
			)
		);

CREATE TABLE usage_monitoring_event_projection_v1 (
			event_id integer primary key,
			timestamp_ms integer not null,
			search_text text not null,
			account_key text not null,
			provider text not null,
			executor_type text not null,
			model text not null,
			requested_model text not null default '',
			analytics_model text not null,
			resolved_model text not null,
			auth_index text not null,
			source text not null,
			source_hash text not null,
			api_key_hash text not null,
			account_snapshot text not null,
			auth_label_snapshot text not null,
			auth_file_snapshot text not null,
			auth_provider_snapshot text not null,
			auth_account_id_snapshot text not null default '',
			auth_project_id_snapshot text not null,
			reasoning_effort text not null,
			service_tier text not null,
			failed integer not null,
			latency_ms integer,
			input_tokens integer not null,
			output_tokens integer not null,
			reasoning_tokens integer not null,
			cached_tokens integer not null,
			cache_tokens integer not null,
			cache_read_tokens integer not null,
			cache_creation_tokens integer not null,
			normalized_total_input_tokens integer not null,
			total_tokens integer not null,
			header_quota_plan_type text not null,
			header_error_kind text not null,
			header_error_code text not null,
			header_trace_id text not null,
			updated_at_ms integer not null
		);

CREATE VIRTUAL TABLE usage_monitoring_event_search_v1 using fts5(
			search_text,
			content = 'usage_monitoring_event_projection_v1',
			content_rowid = 'event_id',
			columnsize = 0,
			detail = 'none',
			tokenize = 'trigram'
		);

CREATE TABLE usage_monitoring_header_latest_v1 (
			snapshot_key text primary key,
			event_id integer not null,
			event_hash text not null,
			timestamp_ms integer not null,
			auth_file_snapshot text not null,
			auth_index text not null,
			account_snapshot text not null,
			auth_label_snapshot text not null,
			auth_provider_snapshot text not null,
			auth_account_id_snapshot text not null default '',
			auth_project_id_snapshot text not null,
			source text not null,
			source_hash text not null,
			response_metadata_json text not null,
			header_quota_recover_at_ms integer,
			header_quota_used_percent real,
			header_quota_plan_type text not null,
			header_error_kind text not null,
			header_error_code text not null,
			header_trace_id text not null,
			updated_at_ms integer not null
		);

CREATE TABLE usage_monitoring_rollup_state (
			rollup_name text primary key,
			schema_version integer not null,
			structure_revision text not null default '',
			status text not null,
			backfill_last_event_id integer not null default 0,
			coverage_event_id integer not null default 0,
			target_event_id integer not null default 0,
			processed_events integer not null default 0,
			last_run_started_at_ms integer,
			updated_at_ms integer not null default 0,
			finished_at_ms integer,
			last_error text
		);

CREATE TABLE usage_monitoring_search_index_state (
			id integer primary key check (id = 1),
			ready integer not null default 0,
			updated_at_ms integer not null default 0
		);

CREATE TABLE usage_monitoring_selector_daily_rollups_v1 (
			model_format_revision text not null default '',
			bucket_ms integer not null,
			model text not null,
			api_key_hash text not null,
			provider text not null,
			auth_file_snapshot text not null,
			account_snapshot text not null,
			auth_label_snapshot text not null,
			auth_index text not null,
			source text not null,
			source_hash text not null,
			updated_at_ms integer not null,
			primary key (
				bucket_ms, model, api_key_hash, provider, auth_file_snapshot,
				account_snapshot, auth_label_snapshot, auth_index, source_hash
			)
		);

CREATE TABLE usage_pricing_account_rollups_v1 (
		structure_revision text not null,
		account_key text not null,
		account_snapshot text,
		auth_label_snapshot text,
		auth_provider_snapshot text,
		auth_index text,
		source text,
		source_hash text,
		model text not null,
		billing_model text not null,
		pricing_model text not null,
		service_tier text not null,
		context_threshold_tokens integer not null,
		calls integer not null default 0,
		success_calls integer not null default 0,
		failure_calls integer not null default 0,
		input_tokens integer not null default 0,
		output_tokens integer not null default 0,
		reasoning_tokens integer not null default 0,
		cached_tokens integer not null default 0,
		cache_read_tokens integer not null default 0,
		cache_creation_tokens integer not null default 0,
		long_input_tokens integer not null default 0,
		long_output_tokens integer not null default 0,
		long_cached_tokens integer not null default 0,
		long_cache_read_tokens integer not null default 0,
		long_cache_creation_tokens integer not null default 0,
		total_tokens integer not null default 0,
		first_seen_ms integer not null,
		last_seen_ms integer not null,
		updated_at_ms integer not null,
		primary key (
			structure_revision, account_key, model, billing_model, pricing_model,
			service_tier, context_threshold_tokens
		)
		);

CREATE TABLE usage_pricing_hourly_rollups_v1 (
			structure_revision text not null,
			bucket_ms integer not null,
			model text not null,
			billing_model text not null,
			pricing_model text not null,
			service_tier text not null,
			context_threshold_tokens integer not null,
			failed integer not null,
			calls integer not null default 0,
			input_tokens integer not null default 0,
			output_tokens integer not null default 0,
			reasoning_tokens integer not null default 0,
			cached_tokens integer not null default 0,
			cache_read_tokens integer not null default 0,
			cache_creation_tokens integer not null default 0,
			long_input_tokens integer not null default 0,
			long_output_tokens integer not null default 0,
			long_cached_tokens integer not null default 0,
			long_cache_read_tokens integer not null default 0,
			long_cache_creation_tokens integer not null default 0,
			total_tokens integer not null default 0,
			latency_sum_ms integer not null default 0,
			latency_samples integer not null default 0,
			zero_token_calls integer not null default 0,
			updated_at_ms integer not null,
			primary key (
				structure_revision, bucket_ms, model, billing_model, pricing_model,
				service_tier, context_threshold_tokens, failed
			)
		);

CREATE TABLE usage_pricing_rollup_state (
			rollup_name text primary key,
			schema_version integer not null,
			structure_revision text not null default '',
			status text not null,
			backfill_last_event_id integer not null default 0,
			coverage_event_id integer not null default 0,
			target_event_id integer not null default 0,
			processed_events integer not null default 0,
			min_bucket_ms integer,
			max_bucket_ms integer,
			last_run_started_at_ms integer,
			updated_at_ms integer not null default 0,
			finished_at_ms integer,
			last_error text
		);

CREATE TABLE usage_rollup_checkpoints (
			name text primary key,
			last_event_id integer not null default 0,
			updated_at_ms integer not null,
			last_error text,
			last_run_started_at_ms integer,
			last_run_finished_at_ms integer
		);

CREATE TABLE usage_rollup_rebuild_state (
		name text primary key,
		target_event_id integer not null default 0,
		updated_at_ms integer not null default 0
	);

CREATE UNIQUE INDEX idx_account_action_candidates_pending_identity_action
		on account_action_candidates(
			auth_file_name,
			action_type,
			coalesce(trim(reason_code), ''),
			coalesce(trim(auth_index), ''),
			case when coalesce(trim(auth_index), '') <> '' then '' else coalesce(trim(account_id_snapshot), '') end,
			case when coalesce(trim(auth_index), '') <> '' then ''
				else case coalesce(lower(replace(trim(provider), '_', '-')), '')
					when 'x-ai' then 'xai'
					when 'grok' then 'xai'
					else coalesce(lower(replace(trim(provider), '_', '-')), '')
				end
			end,
			case when coalesce(trim(auth_index), '') <> '' or coalesce(trim(account_id_snapshot), '') <> '' then ''
				else coalesce(trim(account_snapshot), '')
			end
		) where status = 'pending';

CREATE INDEX idx_account_action_candidates_status_seen on account_action_candidates(status, last_seen_at_ms);

CREATE INDEX idx_codex_inspection_leases_expiry on codex_inspection_leases(lease_expires_at_ms);

CREATE INDEX idx_codex_inspection_logs_run on codex_inspection_logs(run_id, created_at_ms);

CREATE INDEX idx_codex_inspection_results_run on codex_inspection_results(run_id);

CREATE INDEX idx_codex_inspection_runs_started_at on codex_inspection_runs(started_at_ms);

CREATE INDEX idx_codex_inspection_runs_status on codex_inspection_runs(status);

CREATE INDEX idx_codex_inspection_runs_trigger on codex_inspection_runs(trigger_type, trigger_key);

CREATE UNIQUE INDEX idx_quota_activations_active on account_quota_window_activations(window_id) where deactivated_at_ms is null;

CREATE UNIQUE INDEX idx_quota_cooldowns_active_identity
		on quota_cooldowns (
			auth_file_name,
			owner,
			coalesce(trim(auth_index), ''),
			case
				when coalesce(trim(auth_index), '') <> '' then ''
				else case coalesce(lower(replace(trim(provider), '_', '-')), '')
					when 'x-ai' then 'xai'
					when 'grok' then 'xai'
					else coalesce(lower(replace(trim(provider), '_', '-')), '')
				end
			end,
			case
				when coalesce(trim(auth_index), '') <> '' then ''
				else coalesce(trim(account_snapshot), '')
			end
		)
		where status = 'active';

CREATE INDEX idx_quota_cooldowns_due on quota_cooldowns(status, recover_at_ms);

CREATE UNIQUE INDEX idx_quota_cycles_active on account_quota_cycles(activation_id) where actual_end_ms is null;

CREATE INDEX idx_quota_cycles_history on account_quota_cycles(activation_id, actual_start_ms desc);

CREATE INDEX idx_quota_observations_account_time on account_quota_observations(account_key, provider, observed_at_ms desc);

CREATE INDEX idx_quota_observations_inventory on account_quota_observations(account_key, provider, inventory_scope_key, observed_at_ms desc);

CREATE INDEX idx_quota_observations_lifecycle_watermark on account_quota_observations(account_key, provider, inventory_scope_key, lifecycle_applied, observed_at_ms desc);

CREATE INDEX idx_quota_snapshots_cycle_evidence on account_quota_snapshots(cycle_id, observed_at_ms, id);

CREATE INDEX idx_quota_snapshots_latest on account_quota_snapshots(account_key, provider, provider_window_id, model_scope_kind, model_scope_key, observed_at_ms desc);

CREATE INDEX idx_quota_snapshots_legacy_migration on account_quota_snapshots(
		account_key, provider, observed_at_ms,
		case lower(trim(source))
			when 'response_body' then 1
			when 'api_query' then 2
			when 'inspection' then 3
			else 0
		end,
		coalesce(source_observation_id, ''), id
	) where observation_id is null;

CREATE INDEX idx_quota_snapshots_observation on account_quota_snapshots(observation_id);

CREATE INDEX idx_quota_snapshots_window_cycle on account_quota_snapshots(logical_window_id, cycle_id, observed_at_ms desc);

CREATE INDEX idx_quota_windows_account_state on account_quota_windows(account_key, provider, availability, updated_at_ms desc);

CREATE INDEX idx_quota_windows_inventory on account_quota_windows(account_key, provider, inventory_scope_key, availability);

CREATE INDEX idx_usage_account_model_rollups_auth_index on usage_account_model_rollups(auth_index);

CREATE INDEX idx_usage_account_model_rollups_last_seen on usage_account_model_rollups(last_seen_ms);

CREATE INDEX idx_usage_event_identity_ledger_bucket on usage_event_identity_ledger(bucket_ms);

CREATE INDEX idx_usage_event_identity_ledger_raw_event_id on usage_event_identity_ledger(raw_event_id);

CREATE INDEX idx_usage_events_auth_index on usage_events(auth_index);

CREATE INDEX idx_usage_events_endpoint on usage_events(endpoint);

CREATE INDEX idx_usage_events_header_error_kind on usage_events(header_error_kind);

CREATE INDEX idx_usage_events_header_quota_recover on usage_events(header_quota_recover_at_ms);

CREATE INDEX idx_usage_events_header_trace_id on usage_events(header_trace_id);

CREATE INDEX idx_usage_events_latest_request_auth_file on usage_events(auth_file_snapshot collate nocase, auth_index collate nocase, timestamp_ms desc, id desc);

CREATE INDEX idx_usage_events_latest_request_source on usage_events(source collate nocase, auth_index collate nocase, timestamp_ms desc, id desc);

CREATE INDEX idx_usage_events_model on usage_events(model);

CREATE INDEX idx_usage_events_request_id on usage_events(request_id);

CREATE INDEX idx_usage_events_timestamp on usage_events(timestamp_ms);

CREATE INDEX idx_usage_monitoring_account_daily_bucket on usage_monitoring_account_daily_rollups_v1(structure_revision, bucket_ms);

CREATE INDEX idx_usage_monitoring_account_daily_credential_window on usage_monitoring_account_daily_rollups_v1(structure_revision, trim(auth_file_snapshot), trim(auth_index), bucket_ms);

CREATE INDEX idx_usage_monitoring_account_daily_legacy_window on usage_monitoring_account_daily_rollups_v1(structure_revision, trim(source), trim(auth_index), bucket_ms);

CREATE INDEX idx_usage_monitoring_api_key_daily_bucket on usage_monitoring_api_key_daily_rollups_v1(structure_revision, bucket_ms);

CREATE INDEX idx_usage_monitoring_event_projection_account_window on usage_monitoring_event_projection_v1(account_key, timestamp_ms, event_id);

CREATE INDEX idx_usage_monitoring_event_projection_model_timestamp on usage_monitoring_event_projection_v1(analytics_model, timestamp_ms desc, event_id desc);

CREATE INDEX idx_usage_monitoring_event_projection_timestamp on usage_monitoring_event_projection_v1(timestamp_ms desc, event_id desc);

CREATE INDEX idx_usage_monitoring_header_latest_timestamp on usage_monitoring_header_latest_v1(timestamp_ms desc, event_id desc);

CREATE INDEX idx_usage_monitoring_selector_daily_bucket on usage_monitoring_selector_daily_rollups_v1(bucket_ms);

CREATE INDEX idx_usage_monitoring_selector_revision_bucket on usage_monitoring_selector_daily_rollups_v1(model_format_revision, bucket_ms);

CREATE INDEX idx_usage_pricing_account_key on usage_pricing_account_rollups_v1(structure_revision, account_key);

CREATE INDEX idx_usage_pricing_hourly_bucket on usage_pricing_hourly_rollups_v1(structure_revision, bucket_ms);

CREATE TRIGGER usage_monitoring_event_search_v1_delete
			after delete on usage_monitoring_event_projection_v1 begin
			insert into usage_monitoring_event_search_v1(usage_monitoring_event_search_v1, rowid, search_text) values ('delete', old.event_id, old.search_text);
		end;

CREATE TRIGGER usage_monitoring_event_search_v1_insert
			after insert on usage_monitoring_event_projection_v1 begin
			insert into usage_monitoring_event_search_v1(rowid, search_text) values (new.event_id, new.search_text);
		end;

CREATE TRIGGER usage_monitoring_event_search_v1_update
			after update of search_text on usage_monitoring_event_projection_v1 begin
			insert into usage_monitoring_event_search_v1(usage_monitoring_event_search_v1, rowid, search_text) values ('delete', old.event_id, old.search_text);
			insert into usage_monitoring_event_search_v1(rowid, search_text) values (new.event_id, new.search_text);
		end;
