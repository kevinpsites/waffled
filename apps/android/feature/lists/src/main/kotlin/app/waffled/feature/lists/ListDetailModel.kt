package app.waffled.feature.lists

import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** How the grocery board is grouped. */
enum class GroceryViewMode { Aisle, Store, Meal }

/**
 * One list's items — works for any list, grocery included.
 *
 * Lists are not a PowerSync table, so this is REST end to end: load on open, on
 * pull-to-refresh, on a silent liveness poll, and after every write.
 *
 * Methods are plain `suspend` functions rather than `viewModelScope.launch` calls, so the
 * whole state machine is drivable from a JVM test with no main-dispatcher rule — the same
 * shape as `PhotosModel`.
 */
class ListDetailModel(
    initialList: ListSummary,
    /** Public so the staples sheet can issue its own writes against the same slice. */
    val api: ListsApi,
    private val refreshBus: RefreshBus? = null,
) {
    private val _list = MutableStateFlow(initialList)

    /** Mutable so converting to/from a template flips this screen in place. */
    val listState: StateFlow<ListSummary> = _list.asStateFlow()
    val list: ListSummary get() = _list.value

    private val _items = MutableStateFlow<List<ListItemDTO>>(emptyList())
    val itemsState: StateFlow<List<ListItemDTO>> = _items.asStateFlow()
    val items: List<ListItemDTO> get() = _items.value

    private val _settling = MutableStateFlow<Set<String>>(emptySet())

    /** Checked items still shown in place, before they settle into Completed. */
    val settlingState: StateFlow<Set<String>> = _settling.asStateFlow()

    private val _loading = MutableStateFlow(true)
    val loadingState: StateFlow<Boolean> = _loading.asStateFlow()

    private val _error = MutableStateFlow(false)
    val errorState: StateFlow<Boolean> = _error.asStateFlow()

    private val _board = MutableStateFlow(GroceryBoardDTO())
    val boardState: StateFlow<GroceryBoardDTO> = _board.asStateFlow()

    private val _knownStores = MutableStateFlow<List<String>>(emptyList())
    val knownStoresState: StateFlow<List<String>> = _knownStores.asStateFlow()

    private val _search = MutableStateFlow("")
    val searchState: StateFlow<String> = _search.asStateFlow()

    private val _shareText = MutableStateFlow("")
    private val _shareMarkdown = MutableStateFlow("")

    /**
     * The list as shareable plain text, rebuilt whenever the items change.
     *
     * Derived once per data change rather than in a getter: the Share control lives in the
     * app bar, which recomposes on every keystroke in the search field, and formatting is
     * an O(n) group-and-sort over the whole list.
     *
     * Built from ALL items, deliberately not the search-filtered ones: sharing "the list"
     * should hand over the whole list rather than whatever the sharer happened to have
     * typed in the search box. (`items` is already scoped to the week being viewed, and
     * the formatter drops checked rows itself.)
     */
    val shareTextState: StateFlow<String> = _shareText.asStateFlow()
    val shareMarkdownState: StateFlow<String> = _shareMarkdown.asStateFlow()

    val isGrocery: Boolean get() = list.isGrocery
    val isTemplate: Boolean get() = list.isTemplate

    /** Which week to request; null = the server's current week. */
    var requestedWeekStart: String? = null
        private set

    /** Steps taken from the current week — for the LABEL only, never for the request. */
    var weekOffset: Int = 0
        private set

    /**
     * Counts local edits.
     *
     * A silent poll records this before it goes out and drops its answer if anything
     * changed while it was in the air: the server composed that answer before our edit
     * reached it, so applying it would undo what's on screen — a deleted row reappearing,
     * a checked row going back to unchecked — until the next poll. An explicit reload
     * isn't guarded: the user asked for server truth.
     */
    private var edits = 0

    companion object {
        /** Canonical grocery aisles in shopping order (mirrors the server's `aisles.ts`). */
        val GROCERY_AISLES = listOf("Produce", "Pantry", "Dairy & Chilled", "Meat & Seafood", "Bakery", "Frozen", "Other")
    }

    // ---- derived views ---------------------------------------------------------

    fun setSearch(query: String) {
        _search.value = query
    }

    /** True if the item matches the current search (name / section / quantity). */
    private fun matches(item: ListItemDTO): Boolean {
        val q = _search.value.trim().lowercase()
        if (q.isEmpty()) return true
        if (item.name.lowercase().contains(q)) return true
        if (item.section?.lowercase()?.contains(q) == true) return true
        if (item.quantity?.lowercase()?.contains(q) == true) return true
        return false
    }

    /** Active items: unchecked, plus just-checked ones that haven't settled yet. */
    private val activeItems: List<ListItemDTO>
        get() = items.filter { (!it.checked || it.id in _settling.value) && matches(it) }

    val activeSections: List<ListSectionGroup>
        get() = ListGrouping.sections(activeItems, if (isGrocery) GROCERY_AISLES else emptyList())

    val storeSections: List<ListSectionGroup> get() = StoreGrouping.sections(activeItems)

    val mealSections: List<MealGroup>
        get() = MealGrouping.sections(
            items = activeItems,
            meals = _board.value.meals,
            unscheduled = _board.value.unscheduled,
            unscheduledMeals = _board.value.unscheduledMeals,
        )

    val completed: List<ListItemDTO>
        get() = items.filter { it.checked && it.id !in _settling.value && matches(it) }

    fun dotColors(item: ListItemDTO): List<String> = MealDots.colors(
        item = item,
        meals = _board.value.meals,
        unscheduledMeals = _board.value.unscheduledMeals,
        unscheduled = _board.value.unscheduled,
    )

    val sectionSuggestions: List<String>
        get() {
            val result = if (isGrocery) GROCERY_AISLES.toMutableList() else mutableListOf()
            for (s in items.mapNotNull { it.section }) {
                if (s.isNotEmpty() && s !in result) result.add(s)
            }
            return result
        }

    val storeSuggestions: List<String>
        get() {
            val result = _knownStores.value.toMutableList()
            for (s in items.mapNotNull { it.store }) {
                if (s.isNotEmpty() && s !in result) result.add(s)
            }
            return result
        }

    // ---- loading ---------------------------------------------------------------

    /**
     * [silent] keeps the current items on screen (no spinner) — used by the foreground
     * refresh and the 20-second liveness poll, so another device's edits fold in without
     * a visible reload flash.
     */
    suspend fun load(silent: Boolean = false) {
        if (!silent) {
            _loading.value = true
            _settling.value = emptySet()
        }
        val startedAt = edits
        try {
            if (isGrocery) {
                val board = api.groceryBoard(requestedWeekStart)
                // Grocery rows group by AISLE, but only the board sends it — backfill the
                // section so the board on screen and the shared text can never disagree.
                val rows = board.items.map { if (it.section == null) it.copy(section = it.aisle) else it }
                val stores = runCatching { api.stores() }.getOrDefault(_knownStores.value)
                if (!silent || edits == startedAt) {
                    _board.value = board
                    setItems(rows)
                    _knownStores.value = stores
                }
            } else {
                val rows = api.items(list.id)
                if (!silent || edits == startedAt) setItems(rows)
            }
            _error.value = false
        } catch (_: Exception) {
            _error.value = true
        } finally {
            if (!silent) _loading.value = false
        }
    }

    /** Items always move through here, so the share text can't fall out of step. */
    private fun setItems(rows: List<ListItemDTO>) {
        _items.value = rows
        _shareText.value = ShareList.formatRows(rows)
        _shareMarkdown.value = ShareList.formatMarkdownRows(rows)
    }

    private fun noteLocalEdit() {
        edits += 1
    }

    // ---- writes ----------------------------------------------------------------

    suspend fun add(name: String, quantity: String, section: String? = null): ListItemDTO? {
        val n = name.trim()
        if (n.isEmpty()) return null
        val qty = quantity.trim().takeIf { it.isNotEmpty() }
        val sec = section?.trim()?.takeIf { it.isNotEmpty() }
        return try {
            val created = if (isGrocery) {
                api.addGroceryItem(n, qty, sec)
            } else {
                api.addItem(list.id, n, qty, sec)
            }
            invalidate()
            load()
            created
        } catch (_: Exception) {
            _error.value = true
            null
        }
    }

    /**
     * Optimistic toggle.
     *
     * Checking keeps the row in place briefly (settling), so ticking something doesn't
     * make it vanish from under your finger; [settle] then drops it into Completed.
     * Unchecking returns it to its section at once.
     */
    suspend fun toggle(id: String) {
        val current = items.firstOrNull { it.id == id } ?: return
        val target = !current.checked
        noteLocalEdit()
        setItems(items.map { if (it.id == id) it.copy(checked = target) else it })
        _settling.value = if (target) _settling.value + id else _settling.value - id
        try {
            api.patchItem(id, checked = target)
            invalidate()
        } catch (_: Exception) {
            setItems(items.map { if (it.id == id) it.copy(checked = !target) else it })
            _settling.value = _settling.value - id
        }
    }

    /**
     * Drop [id] out of the settling set so it falls into Completed.
     *
     * Only settles a row that is still checked — the user may have toggled it back while
     * the timer ran.
     */
    fun settle(id: String) {
        if (items.firstOrNull { it.id == id }?.checked != true) return
        _settling.value = _settling.value - id
    }

    /** Optimistic inline edit; reverts on failure. */
    suspend fun edit(id: String, name: String, quantity: String) {
        val prev = items.firstOrNull { it.id == id } ?: return
        val n = name.trim()
        if (n.isEmpty()) return
        val qty = quantity.trim()
        // Compare against the SEED, not the display quantity: the box holds "1 1/2 lb"
        // while the row holds "1½ lb", so comparing the two makes every tap-away an edit.
        if (n == prev.name && qty == prev.editableQuantity) return
        noteLocalEdit()
        setItems(
            items.map {
                if (it.id != id) it
                else it.copy(
                    name = n,
                    quantity = qty.takeIf { q -> q.isNotEmpty() },
                    // The typed text is the typable form, so it seeds the next edit too —
                    // otherwise reopening the row before the next load shows the old value.
                    quantityInput = qty.takeIf { q -> q.isNotEmpty() },
                )
            },
        )
        try {
            api.patchItem(id, name = n, quantity = Field.blankAsClear(qty))
            invalidate()
        } catch (_: Exception) {
            setItems(items.map { if (it.id == id) prev else it })
        }
    }

    /** Optimistic full-detail edit (name / quantity / assignee / section / store / priority). */
    suspend fun editDetails(
        id: String,
        name: String,
        quantity: String,
        assignee: ListItemDTO.Assignee?,
        section: String,
        store: String,
        priority: Int,
    ) {
        val prev = items.firstOrNull { it.id == id } ?: return
        val n = name.trim()
        if (n.isEmpty()) return
        val qty = quantity.trim()
        val sec = section.trim()
        val st = store.trim()
        noteLocalEdit()
        setItems(
            items.map {
                if (it.id != id) it
                else it.copy(
                    name = n,
                    quantity = qty.takeIf { q -> q.isNotEmpty() },
                    quantityInput = qty.takeIf { q -> q.isNotEmpty() },
                    section = sec.takeIf { s -> s.isNotEmpty() },
                    store = st.takeIf { s -> s.isNotEmpty() },
                    priority = priority,
                    assignee = assignee,
                )
            },
        )
        try {
            api.updateItemDetails(id, n, qty, assignee?.personId, sec, st, priority)
            invalidate()
        } catch (_: Exception) {
            setItems(items.map { if (it.id == id) prev else it })
        }
    }

    /**
     * Move an item to a different section, PATCHing just its category. Optimistic;
     * reverts on failure.
     *
     * This is what [ListReorder]'s rule resolves to — a null [section] clears the
     * category rather than minting a literal "Items" one.
     */
    suspend fun moveToSection(id: String, section: String?) {
        val prev = items.firstOrNull { it.id == id } ?: return
        val target = section?.trim()?.takeIf { it.isNotEmpty() }
        if (prev.section == target) return
        noteLocalEdit()
        setItems(items.map { if (it.id == id) it.copy(section = target) else it })
        try {
            api.patchItem(id, section = Field.Set(target))
            invalidate()
        } catch (_: Exception) {
            setItems(items.map { if (it.id == id) prev else it })
        }
    }

    /** Optimistic removal; restores on failure. */
    suspend fun remove(id: String) {
        val snapshot = items
        noteLocalEdit()
        setItems(items.filterNot { it.id == id })
        try {
            api.deleteItem(id)
            invalidate()
        } catch (_: Exception) {
            setItems(snapshot)
        }
    }

    /**
     * Clear the Completed section now — soft-deletes every checked item server-side.
     *
     * CUSTOM lists only. On grocery, `checked` means "in cart" and clear-completed is a
     * server-side no-op, so this would optimistically wipe in-cart rows that then come
     * straight back.
     */
    suspend fun clearCompleted() {
        if (isGrocery || isTemplate) return
        val snapshot = items
        noteLocalEdit()
        setItems(items.filterNot { it.checked })
        _settling.value = emptySet()
        try {
            api.clearCompleted(list.id)
            invalidate()
        } catch (_: Exception) {
            setItems(snapshot)
        }
    }

    /** Bulk-edit across [ids] in one call, then reload so grouping/badges reflect it. */
    suspend fun bulkPatch(
        ids: List<String>,
        section: Field<String> = Field.Absent,
        assignedTo: Field<String> = Field.Absent,
        priority: Int? = null,
    ) {
        if (ids.isEmpty()) return
        try {
            api.bulkPatchItems(ids, section = section, assignedTo = assignedTo, priority = priority)
            invalidate()
            load()
        } catch (_: Exception) {
            _error.value = true
        }
    }

    // ---- the grocery panels ----------------------------------------------------

    /**
     * Add a pantry staple to the list anyway (staples are normally assumed in-house).
     * Returns the aisle it landed in, for the confirmation toast.
     */
    suspend fun addStaple(name: String): String? = try {
        api.addGroceryItem(name)
        invalidate()
        load()
        items.firstOrNull { it.name.equals(name, ignoreCase = true) }?.section
    } catch (_: Exception) {
        _error.value = true
        null
    }

    /** Reload just the staples master list (after editing them in the sheet). */
    suspend fun reloadStaples() {
        val fresh = runCatching { api.pantryStaples() }.getOrNull() ?: return
        _board.value = _board.value.copy(staples = fresh)
    }

    /**
     * Rebuild the meal-derived rows for the week on screen.
     *
     * The server recomputes only `source = 'auto'` rows — hand-added and explicit
     * off-plan rows survive — and hands back the refreshed board, so this is a single
     * round-trip rather than a write plus a re-fetch.
     */
    suspend fun rebuild() {
        val week = _board.value.weekStart
        if (week.isEmpty()) return
        try {
            applyBoard(api.rebuildGrocery(week))
            invalidate()
        } catch (_: Exception) {
            _error.value = true
        }
    }

    /** "Start over": un-check everything on this week's list (rebuild keeps checks). */
    suspend fun startOver() {
        val week = _board.value.weekStart
        if (week.isEmpty()) return
        try {
            applyBoard(api.clearGroceryChecks(week))
            invalidate()
        } catch (_: Exception) {
            _error.value = true
        }
    }

    private fun applyBoard(board: GroceryBoardDTO) {
        _board.value = board
        _settling.value = emptySet()
        setItems(board.items.map { if (it.section == null) it.copy(section = it.aisle) else it })
        noteLocalEdit()
    }

    /** Take an off-plan recipe back off the list; reloads (it can touch several rows). */
    suspend fun removeRecipe(recipeId: String) {
        try {
            api.removeRecipeFromGrocery(recipeId, _board.value.weekStart.takeIf { it.isNotEmpty() })
            invalidate()
            load()
        } catch (_: Exception) {
            _error.value = true
        }
    }

    /**
     * Take a whole Meal Builder plate back off the list.
     *
     * A row only goes when the plate is its *sole* reason for existing — anything the
     * week's own plan still needs survives with the plate's credit stripped, so this
     * can't delete shopping someone else put there.
     */
    suspend fun removeMeal(mealId: String) {
        try {
            api.removeMealFromGrocery(mealId, _board.value.weekStart.takeIf { it.isNotEmpty() })
            invalidate()
            load()
        } catch (_: Exception) {
            _error.value = true
        }
    }

    // ---- template mode ---------------------------------------------------------

    /** Turn this list into a reusable template — converts it in place and unchecks it. */
    suspend fun convertToTemplate(): Boolean = try {
        _list.value = api.saveAsTemplate(list.id)
        invalidate()
        load() // items came back unchecked server-side
        true
    } catch (_: Exception) {
        _error.value = true
        false
    }

    /** Use this template — a fresh list from its current items, all unchecked. */
    suspend fun useTemplate(): ListSummary? = try {
        val created = api.applyTemplate(list.id)
        invalidate()
        created
    } catch (_: Exception) {
        _error.value = true
        null
    }

    /** Move this template back into the active Lists rail (undo a convert). */
    suspend fun moveToLists(): Boolean = try {
        _list.value = api.unmarkTemplate(list.id)
        invalidate()
        true
    } catch (_: Exception) {
        _error.value = true
        false
    }

    /** Edit the list's name AND emoji. A blank emoji CLEARS it. */
    suspend fun editList(name: String, emoji: String): Boolean {
        val n = name.trim()
        if (n.isEmpty()) return false
        return try {
            _list.value = api.updateList(list.id, name = n, emoji = Field.Set(emoji.trim()))
            invalidate()
            true
        } catch (_: Exception) {
            _error.value = true
            false
        }
    }

    /** Soft-delete the whole list. */
    suspend fun deleteList(): Boolean = try {
        api.deleteList(list.id)
        invalidate()
        true
    } catch (_: Exception) {
        _error.value = true
        false
    }

    // ---- the week switcher -----------------------------------------------------

    /**
     * Move [weeks] weeks from the week the SERVER last returned, and reload.
     *
     * The step is never taken from a locally-computed week — see [GroceryWeekStep].
     */
    suspend fun stepWeek(weeks: Int) {
        val next = GroceryWeekStep.step(_board.value.weekStart, weeks) ?: return
        weekOffset += weeks
        requestedWeekStart = next
        load()
    }

    /** Back to the server's own current week — null, not a computed date. */
    suspend fun thisWeek() {
        weekOffset = 0
        requestedWeekStart = null
        load()
    }

    private fun invalidate() {
        refreshBus?.bump(RefreshDomain.Lists)
    }
}
