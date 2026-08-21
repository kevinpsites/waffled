package app.waffled.feature.recipes

import android.content.Context
import android.content.Intent

/**
 * Hand a compiled recipe to the platform share sheet — the Android twin of
 * `apps/ios/.../Features/Meals/RecipeShareSheet.swift`.
 *
 * `ACTION_SEND` with the Markdown as `EXTRA_TEXT`, deliberately: iOS writes a temp `.md`
 * file because `UIActivityViewController` shares *items*, and Files/Mail want a real
 * attachment. Android's chooser takes text directly, and every target that matters
 * (Messages, Gmail, Keep, Drive, the clipboard) accepts it — so a FileProvider, a cache
 * directory to clean up, and a URI grant would all be machinery bought for nothing.
 *
 * The recipe's suggested filename becomes the subject, so a mailed recipe still arrives
 * with its own name on it.
 */
object RecipeShare {

    /** The chooser intent for one compiled recipe. */
    fun intent(title: String, markdown: RecipeMarkdown): Intent {
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/markdown"
            putExtra(Intent.EXTRA_TITLE, title)
            putExtra(Intent.EXTRA_SUBJECT, markdown.filename.removeSuffix(".md").ifEmpty { title })
            putExtra(Intent.EXTRA_TEXT, markdown.markdown)
        }
        return Intent.createChooser(send, "Share $title")
    }

    /**
     * Present the chooser.
     *
     * `FLAG_ACTIVITY_NEW_TASK` is added only when the context is not an Activity — a
     * feature module cannot assume which it was handed, and starting a chooser from an
     * application context without it throws.
     */
    fun share(context: Context, title: String, markdown: RecipeMarkdown) {
        val chooser = intent(title, markdown)
        if (context !is android.app.Activity) chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(chooser)
    }
}
