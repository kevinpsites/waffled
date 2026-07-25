-- Up Migration
-- Waffled-Bites: a kid-owned 7" companion device (ESP32/LVGL firmware, built
-- separately) paired one-per-child. Modeled on kiosk_devices/kiosk_pairing_codes
-- (0043_kiosk.sql) but fixed to a single person_id rather than a shared household
-- picker, and with a settings/runtime_state jsonb split: settings is parent-configured
-- (night light, sound machine, alarm, wake-light schedules, display, quiet-time
-- defaults); runtime_state is live/ephemeral (quiet-timer, visual-timer, pending nudge)
-- and stores timestamps rather than ticking counters so remaining time is always
-- computed on read, never drifted by repeated writes.

create table waffled_bite_devices (
  id                   uuid primary key default gen_random_uuid(),
  household_id         uuid not null references households(id),
  person_id            uuid not null references persons(id),
  label                text not null default 'Waffled-Bite',
  token_hash           text not null,
  settings             jsonb not null default '{}'::jsonb,
  runtime_state        jsonb not null default '{}'::jsonb,
  created_by_person_id uuid references persons(id),
  last_seen_at         timestamptz,
  created_at           timestamptz not null default now(),
  revoked_at           timestamptz
);
create index ix_waffled_bite_devices_token on waffled_bite_devices (token_hash) where revoked_at is null;
create index ix_waffled_bite_devices_household on waffled_bite_devices (household_id) where revoked_at is null;
-- at most one active (paired, non-revoked) device per kid
create unique index uq_waffled_bite_devices_person on waffled_bite_devices (person_id) where revoked_at is null;

-- Short-lived, one-time pairing codes (same shape as kiosk_pairing_codes), scoped to
-- the specific kid the parent started pairing from (Family → kid → Waffled-Bite).
create table waffled_bite_pairing_codes (
  code         text primary key,
  household_id uuid not null references households(id),
  person_id    uuid not null references persons(id),
  created_by   uuid references persons(id),
  created_at   timestamptz not null default now(),
  consumed_at  timestamptz
);

-- Down Migration

drop table if exists waffled_bite_pairing_codes;
drop table if exists waffled_bite_devices;
