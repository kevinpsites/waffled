package app.waffled.feature.bites

/**
 * UI-only presets for the parent control panel, copied 1:1 from the web's
 * `WaffledBiteDevice.tsx` tables (and the iOS `WaffledBiteOptions`). Nothing here is
 * server-enforced: colour, sound and tone are free-form strings on the wire.
 */
object WaffledBiteOptions {

    data class Option(val key: String, val label: String)

    /** A device LED colour. These are firmware values, not theme colours. */
    data class NightColor(val key: String, val hex: Int)

    val quietPresetsMin = listOf(10, 15, 20, 30, 60)
    val timerPresetsMin = listOf(5, 10, 15, 20, 30)

    /** 0 = "Off". */
    val sleepTimerChipsMin = listOf(0, 15, 30, 60, 120)

    val nightColors = listOf(
        NightColor("amber", 0xF0A94B), NightColor("peach", 0xF28E6B), NightColor("blush", 0xEF7FA6),
        NightColor("lilac", 0xA98BE8), NightColor("ocean", 0x5AA7E0), NightColor("mint", 0x5BC98B),
    )

    val sounds = listOf(
        Option("white", "White noise"), Option("ocean", "Ocean waves"), Option("rain", "Gentle rain"),
        Option("fan", "Box fan"), Option("heartbeat", "Heartbeat"), Option("lullaby", "Lullaby"),
        Option("forest", "Forest"),
    )

    /**
     * Shown but not selectable: they need recordings the device doesn't carry yet. Keep
     * in step with the firmware's `wb_synth_parse` and the web's `SOUNDS_COMING_SOON`.
     */
    val soundsComingSoon = setOf("lullaby", "forest")

    /** The KEY is what `settings.alarm.tone` stores; the firmware's `wb_tone_parse` matches it. */
    val alarmTones = listOf(
        Option("sunriseChime", "Sunrise chime"), Option("birdsong", "Birdsong"), Option("softHarp", "Soft harp"),
        Option("gentleBells", "Gentle bells"), Option("oceanTide", "Ocean tide"), Option("twinkleStars", "Twinkle stars"),
    )

    val alarmTonesComingSoon = setOf("birdsong")

    fun nightHex(key: String): Int = (nightColors.firstOrNull { it.key == key } ?: nightColors[0]).hex

    fun soundLabel(key: String): String =
        sounds.firstOrNull { it.key == key }?.label ?: capitalizeWords(key)

    /** Falls back to the raw stored value: migration 0095 left unrecognised tones alone. */
    fun toneLabel(key: String): String = alarmTones.firstOrNull { it.key == key }?.label ?: key

    /** "Nh" at or above an hour, else "Nm" — the web's `fmtPreset`. */
    fun presetLabel(min: Int): String = if (min >= 60) "${min / 60}h" else "${min}m"

    /** The UI offers 1–180 minutes; the server backstops to the same 3h regardless. */
    fun clampCustomMinutes(min: Int): Int = min.coerceIn(1, 180)

    private fun capitalizeWords(s: String): String =
        s.split(" ").joinToString(" ") { w -> w.lowercase().replaceFirstChar { it.uppercase() } }
}

/** Settings with every section filled in — what the panel renders. */
data class FilledSettings(
    val night: WaffledBitesApi.Night,
    val sound: WaffledBitesApi.Sound,
    val alarm: WaffledBitesApi.Alarm,
    val schedules: List<WaffledBitesApi.Schedule>,
    val display: WaffledBitesApi.Display,
)

/** The same fallbacks the web applies inline (`night ?? {...}`) for a fresh `{}` device. */
fun WaffledBitesApi.Settings.withDefaults(): FilledSettings = FilledSettings(
    night = night ?: WaffledBitesApi.Night(),
    sound = sound ?: WaffledBitesApi.Sound(),
    alarm = alarm ?: WaffledBitesApi.Alarm(volume = WaffledBitesApi.Alarm.DEFAULT_VOLUME),
    schedules = schedules ?: emptyList(),
    display = display ?: WaffledBitesApi.Display(),
)
