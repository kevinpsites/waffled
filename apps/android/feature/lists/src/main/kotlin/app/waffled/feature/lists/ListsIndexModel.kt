package app.waffled.feature.lists

import app.waffled.core.network.RefreshBus
import app.waffled.core.network.RefreshDomain
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The Lists index — every list in the household, plus the saved templates in their own
 * group.
 *
 * Like everything else in this feature it is REST-only: lists are not a synced table, so
 * the index loads on open, on pull-to-refresh, and after every write, and every write
 * bumps [RefreshDomain.Lists] so the other REST-backed screens re-fetch too.
 */
class ListsIndexModel(
    private val api: ListsApi,
    private val refreshBus: RefreshBus? = null,
) {
    private val _lists = MutableStateFlow<List<ListSummary>>(emptyList())
    val listsState: StateFlow<List<ListSummary>> = _lists.asStateFlow()
    val lists: List<ListSummary> get() = _lists.value

    private val _templates = MutableStateFlow<List<ListSummary>>(emptyList())
    val templatesState: StateFlow<List<ListSummary>> = _templates.asStateFlow()
    val templates: List<ListSummary> get() = _templates.value

    private val _loading = MutableStateFlow(true)
    val loadingState: StateFlow<Boolean> = _loading.asStateFlow()

    private val _error = MutableStateFlow(false)
    val errorState: StateFlow<Boolean> = _error.asStateFlow()

    /**
     * Fetch the rail and the templates.
     *
     * Templates are a secondary group, so a server that has no templates route (or one
     * that fails on it) leaves them empty rather than taking the whole index down.
     */
    suspend fun load() {
        _loading.value = true
        try {
            _lists.value = api.lists()
            _templates.value = runCatching { api.templates() }.getOrDefault(emptyList())
            _error.value = false
        } catch (_: Exception) {
            _error.value = true
        } finally {
            _loading.value = false
        }
    }

    /**
     * Create a list and return it, so the caller can open it straight away.
     *
     * Reloads **regardless** of the create reply: the row may have been created even if
     * decoding the reply hiccuped, and the new list should show without a manual refresh.
     */
    suspend fun create(name: String, emoji: String): ListSummary? {
        val n = name.trim()
        if (n.isEmpty()) return null
        var created: ListSummary? = null
        try {
            created = api.createList(n, emoji.trim().takeIf { it.isNotEmpty() })
            invalidate()
        } catch (_: Exception) {
            _error.value = true
        }
        load()
        return created
    }

    /** Rename a list / change its emoji, then reload. A blank emoji CLEARS it. */
    suspend fun update(list: ListSummary, name: String, emoji: String) {
        val n = name.trim()
        if (n.isEmpty()) return
        try {
            api.updateList(list.id, name = n, emoji = Field.Set(emoji.trim()))
            invalidate()
        } catch (_: Exception) {
            _error.value = true
        }
        load()
    }

    /** Optimistic delete; restores the row on failure. */
    suspend fun delete(list: ListSummary) {
        val snapshot = _lists.value
        _lists.value = snapshot.filterNot { it.id == list.id }
        try {
            api.deleteList(list.id)
            invalidate()
        } catch (_: Exception) {
            _lists.value = snapshot
            _error.value = true
        }
    }

    /** Apply a template → a fresh custom list (everything unchecked), then reload. */
    suspend fun applyTemplate(template: ListSummary, name: String?): ListSummary? {
        var created: ListSummary? = null
        try {
            created = api.applyTemplate(template.id, name?.trim()?.takeIf { it.isNotEmpty() })
            invalidate()
        } catch (_: Exception) {
            _error.value = true
        }
        load()
        return created
    }

    /** Optimistic delete of a saved template; restores on failure. */
    suspend fun deleteTemplate(template: ListSummary) {
        val snapshot = _templates.value
        _templates.value = snapshot.filterNot { it.id == template.id }
        try {
            api.deleteList(template.id)
            invalidate()
        } catch (_: Exception) {
            _templates.value = snapshot
            _error.value = true
        }
    }

    private fun invalidate() {
        refreshBus?.bump(RefreshDomain.Lists)
    }
}
