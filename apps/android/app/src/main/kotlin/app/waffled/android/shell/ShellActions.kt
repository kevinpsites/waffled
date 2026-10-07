package app.waffled.android.shell

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import app.waffled.feature.recipes.CookSessionStore
import app.waffled.feature.meals.MealDTO as MealsMeal
import app.waffled.feature.recipes.MealDTO as RecipesMeal
import app.waffled.feature.recipes.RecipeSummary

/** What a hosted screen can ask the shell to do. */
class ShellActions(
    val push: (AppRoute) -> Unit,
    val pop: () -> Unit,
    val replaceTop: (AppRoute) -> Unit,
    val selectTab: (String) -> Unit,
    /** Start (or resume) a cook session, then raise Cook Mode over everything. */
    val cook: (suspend CookSessionStore.() -> Unit) -> Unit,
)

/** Cross-module placeholders: the feature that opens a thing knows less than the one that shows it. */
internal object Placeholders {

    fun recipe(id: String, title: String = "", emoji: String? = null): RecipeSummary =
        RecipeSummary(id = id, title = title, emoji = emoji)

    /** A recipes-side plate, opened on the meals-owned detail. */
    fun meal(m: RecipesMeal): MealsMeal = MealsMeal.placeholder(id = m.id, name = m.name, servings = m.servings)
}

internal fun shareText(context: Context, subject: String, text: String) {
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_SUBJECT, subject)
        putExtra(Intent.EXTRA_TEXT, text)
    }
    context.startActivity(Intent.createChooser(send, subject).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}

internal fun copyText(context: Context, text: String) {
    context.getSystemService(ClipboardManager::class.java)
        ?.setPrimaryClip(ClipData.newPlainText("Waffled", text))
}
