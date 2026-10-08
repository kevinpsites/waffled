package app.waffled.feature.lists

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The Today "Lists" card — pins ONE of the household's custom lists so the hardware run or
 * packing list sits on Today next to everything else.
 *
 * Which list is pinned is a per-DEVICE choice, not household config: the kitchen tablet
 * and a phone want different lists up. It is also what keeps this card out of the layout
 * enum — the saved layout stores the single key `lists` and the *content* is chosen here,
 * so no `list:<uuid>` key ever has to be validated server-side or reaped when its list is
 * deleted.
 */
class TodayListModel(
    private val api: ListsApi,
    /** Reads/writes the pinned list id; per device, so a SharedPreferences seam. */
    private val pinStore: PinStore,
) {
    /** The per-device pinned-list id. Trivial by design — one string. */
    interface PinStore {
        fun pinnedListId(): String?
        fun setPinnedListId(id: String)
    }

    private val _lists = MutableStateFlow<List<ListSummary>>(emptyList())
    private val _items = MutableStateFlow<List<ListItemDTO>>(emptyList())
    private val _loaded = MutableStateFlow(false)
    private val _failed = MutableStateFlow(false)
    private val _done = MutableStateFlow<Set<String>>(emptySet())
    private val _pick = MutableStateFlow(pinStore.pinnedListId())

    val loadedState: StateFlow<Boolean> = _loaded.asStateFlow()

    /**
     * The lists fetch failed. "No lists yet" is a claim about the household, so it must
     * not be made when we simply couldn't ask.
     */
    val failedState: StateFlow<Boolean> = _failed.asStateFlow()
    val listsState: StateFlow<List<ListSummary>> = _lists.asStateFlow()
    val pickState: StateFlow<String?> = _pick.asStateFlow()
    val itemsState: StateFlow<List<ListItemDTO>> = _items.asStateFlow()

    /** Bumped on every local change so a composable reading [open] recomposes. */
    val doneState: StateFlow<Set<String>> = _done.asStateFlow()

    /**
     * The lists this card will offer.
     *
     * The grocery board has its own Today card; offering it here too would be two cards
     * fighting over one list. Templates aren't lists you shop from.
     */
    val pickable: List<ListSummary>
        get() = _lists.value.filterNot { it.isGrocery || it.isTemplate }

    /**
     * A pinned list that has since been deleted must not leave the card blank and stuck,
     * so an unknown pick falls back to whatever the household still has.
     */
    val active: ListSummary?
        get() = pickable.firstOrNull { it.id == _pick.value } ?: pickable.firstOrNull()

    /**
     * The rows worth showing: unfinished ones. A locally-ticked row leaves immediately —
     * the card only ever shows unfinished items, so there is nothing to strike through
     * and wait on.
     */
    val open: List<ListItemDTO>
        get() = _items.value.filter { !it.checked && it.id !in _done.value }

    suspend fun load() {
        val fetched = runCatching { api.lists() }.getOrNull()
        if (fetched != null) {
            _lists.value = fetched
            _failed.value = false
        } else {
            _failed.value = true
        }
        loadItems()
        _loaded.value = true
    }

    suspend fun pick(listId: String) {
        pinStore.setPinnedListId(listId)
        _pick.value = listId
        loadItems()
    }

    /** Tick a row off. Returns false and puts the row back if the write didn't take. */
    suspend fun check(item: ListItemDTO): Boolean {
        _done.value = _done.value + item.id
        return try {
            api.patchItem(item.id, checked = true)
            true
        } catch (_: Exception) {
            _done.value = _done.value - item.id // put it back — the tick didn't take
            false
        }
    }

    private suspend fun loadItems() {
        val list = active
        _done.value = emptySet()
        if (list == null) {
            _items.value = emptyList()
            return
        }
        _items.value = runCatching { api.items(list.id) }.getOrDefault(emptyList())
    }
}
