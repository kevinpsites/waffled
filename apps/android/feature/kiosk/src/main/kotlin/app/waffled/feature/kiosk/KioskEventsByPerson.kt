package app.waffled.feature.kiosk

import app.waffled.core.sync.SyncedEvent

/** Today's events per member, matching on owner OR participant via [SyncedEvent.involves]. */
internal object KioskEventsByPerson {
    fun group(memberIds: List<String>, events: List<SyncedEvent>): Map<String, List<SyncedEvent>> =
        memberIds.associateWith { id -> events.filter { it.involves(id) } }
}
