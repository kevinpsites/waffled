package app.waffled.feature.chores

import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import androidx.core.content.FileProvider
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.waffled.core.design.ApprovalActionPair
import app.waffled.core.design.AvatarFromHex
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledImages
import app.waffled.core.design.WaffledStatusBadge
import coil3.compose.AsyncImage
import java.io.File

/**
 * Photo proof for chores: capturing a completion snapshot, confirming it before it
 * uploads, and a parent's review of one that has landed.
 *
 * Port of `apps/ios/.../Features/Chores/ChoreProof.swift`. iOS wraps
 * `UIImagePickerController`; here the library path is the **system photo picker**
 * (`PickVisualMedia`), which needs no runtime permission, and the camera path is
 * `TakePicture`, which likewise needs no `CAMERA` permission as long as the app doesn't
 * declare one — it hands off to the user's camera app.
 */

// ---------------------------------------------------------------------------
// Capture plumbing
// ---------------------------------------------------------------------------

object ChoreProofCapture {

    /**
     * Whether this device can take a photo at all. The twin of iOS's
     * `isSourceTypeAvailable(.camera)` — false on most emulators, which is exactly when
     * the "Take Photo" choice must be hidden rather than offered and then failing.
     */
    fun cameraAvailable(context: Context): Boolean =
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)

    /**
     * A content URI for the camera app to write into.
     *
     * `TakePicture` writes to a URI we own rather than returning a bitmap, so the full
     * resolution image survives (the `TakePicturePreview` contract returns a thumbnail —
     * useless as proof). The file lives in the cache directory: it exists only long
     * enough to be encoded and uploaded.
     */
    fun newImageUri(context: Context): Uri {
        val dir = File(context.cacheDir, "chore_proofs").apply { mkdirs() }
        val file = File.createTempFile("proof_", ".jpg", dir)
        return FileProvider.getUriForFile(context, "${context.packageName}.choreproof", file)
    }
}

// ---------------------------------------------------------------------------
// The Take Photo / Library choice
// ---------------------------------------------------------------------------

/**
 * "Add a photo to finish this chore" — the twin of iOS's confirmation dialog.
 *
 * A bottom sheet rather than an `AlertDialog`: this is a choice between two actions, not
 * a question about a destructive one, and the sheet keeps the touch targets thumb-sized.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChoreProofChoiceSheet(
    onTakePhoto: () -> Unit,
    onChooseFromLibrary: () -> Unit,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(),
        containerColor = WF.colors.canvas,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .padding(bottom = 40.dp),
            verticalArrangement = Arrangement.spacedBy(WF.spacing.lg),
        ) {
            Text(
                text = "Add a photo to finish this chore",
                style = WF.type.cardTitle,
                color = WF.colors.ink,
            )
            if (ChoreProofCapture.cameraAvailable(context)) {
                ProofChoiceRow(
                    icon = Icons.Filled.PhotoCamera,
                    label = "Take Photo",
                    onClick = onTakePhoto,
                )
            }
            ProofChoiceRow(
                icon = Icons.Filled.PhotoLibrary,
                label = "Choose from Library",
                onClick = onChooseFromLibrary,
            )
        }
    }
}

@Composable
private fun ProofChoiceRow(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(WF.radius.md)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(WF.colors.card, shape)
            .clip(shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 14.dp),
        horizontalArrangement = Arrangement.spacedBy(WF.spacing.lg),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = WF.colors.primary, modifier = Modifier.size(20.dp))
        Text(label, style = WF.type.label, color = WF.colors.ink)
    }
}

// ---------------------------------------------------------------------------
// Confirm a freshly-captured photo BEFORE it uploads
// ---------------------------------------------------------------------------

/**
 * Shown the moment a proof photo is taken or picked, before it uploads — so an accidental
 * tap in the library, or a blurry shot, doesn't silently finish the chore. Port of iOS
 * `ChoreProofConfirm`.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChoreProofConfirm(
    imageUri: Uri,
    row: ChoreRow,
    coin: String?,
    isBusy: Boolean,
    onUse: () -> Unit,
    onRetake: () -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(20.dp)
                .padding(bottom = 40.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            ProofHeader(
                overline = "Finishing",
                title = row.title,
                emoji = row.emoji ?: "🧹",
                coin = coin,
            )

            ProofImage(
                model = imageUri,
                contentDescription = "The photo you just took",
            )

            Row(horizontalArrangement = Arrangement.spacedBy(WF.spacing.md)) {
                // Not `ApprovalActionPair`: that component is the parent's deny/approve
                // decision, and reusing it here would make "Retake" read as a rejection.
                ProofActionButton(
                    label = "Retake",
                    fill = WF.colors.panel,
                    textColor = WF.colors.ink2,
                    modifier = Modifier.weight(1f),
                    onClick = onRetake,
                )
                ProofActionButton(
                    label = if (isBusy) "Uploading…" else "Use this photo",
                    fill = WF.colors.primary,
                    // A saturated coloured fill is the one place a literal white is right.
                    textColor = androidx.compose.ui.graphics.Color.White,
                    modifier = Modifier.weight(1f),
                    enabled = !isBusy,
                    onClick = onUse,
                )
            }
        }
    }
}

@Composable
private fun ProofActionButton(
    label: String,
    fill: androidx.compose.ui.graphics.Color,
    textColor: androidx.compose.ui.graphics.Color,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val pill = RoundedCornerShape(WF.radius.pill)
    Box(
        modifier = modifier
            .background(if (enabled) fill else WF.colors.panel, pill)
            .clip(pill)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(vertical = 13.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold),
            color = if (enabled) textColor else WF.colors.ink3,
        )
    }
}

// ---------------------------------------------------------------------------
// The parent's review of a submitted photo
// ---------------------------------------------------------------------------

/**
 * The large proof photo with who-finished-what context and the Approve / Not-yet actions
 * in one place, so a parent can actually look before deciding. Port of iOS
 * `ChoreProofReview`.
 *
 * [canDecide] is false for someone without `chore.approve` — a child viewing their own
 * submitted photo gets the same sheet, read-only.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChoreProofReview(
    row: ChoreRow,
    memberColorHex: String?,
    coin: String?,
    canDecide: Boolean,
    onApprove: () -> Unit,
    onReject: () -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = WF.colors.canvas,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(20.dp)
                .padding(bottom = 40.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(WF.spacing.lg),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AvatarFromHex(colorHex = memberColorHex, emoji = row.emoji ?: "🙂", size = 40.dp)
                ProofHeaderText(
                    overline = "${row.personName ?: "Someone"} finished",
                    title = row.title,
                    emoji = row.emoji ?: "🧹",
                    coin = coin,
                )
            }

            when {
                row.proofImageUrl != null -> ProofImage(
                    model = WaffledImages.request(
                        LocalContext.current,
                        row.proofImageUrl,
                        row.proofCacheKey,
                    ),
                    contentDescription = "Photo of the finished chore",
                )
                // A proof that expired server-side must say so — otherwise it reads as if
                // the child never attached one.
                row.proofExpired -> ProofPlaceholder("📷 A photo was attached but is no longer saved.")
                else -> ProofPlaceholder("No photo was attached.")
            }

            if (canDecide) {
                ApprovalActionPair(
                    denyLabel = "Not yet",
                    isKiosk = false,
                    onDeny = onReject,
                    onApprove = onApprove,
                )
            } else if (row.isAwaiting) {
                Text(
                    text = "Waiting for a grown-up to OK this.",
                    modifier = Modifier.fillMaxWidth(),
                    style = WF.type.label,
                    color = WF.colors.ink3,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The little tappable thumbnail on a row
// ---------------------------------------------------------------------------

/**
 * The proof thumbnail beside an awaiting or done chore — tap to open the review.
 *
 * Renders nothing for a chore that never had a photo, and a "gone" pill when the proof
 * expired, so the row doesn't silently lose its evidence.
 */
@Composable
fun ChoreProofThumb(
    row: ChoreRow,
    onTap: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(9.dp)
    when {
        row.proofImageUrl != null -> Box(
            modifier = modifier
                .size(44.dp)
                .clip(shape)
                .border(1.dp, WF.colors.hair, shape)
                .clickable(onClick = onTap),
        ) {
            AsyncImage(
                model = WaffledImages.request(
                    LocalContext.current,
                    row.proofImageUrl,
                    row.proofCacheKey,
                ),
                contentDescription = "Photo of the finished chore",
                contentScale = ContentScale.Crop,
                modifier = Modifier
                    .size(44.dp)
                    .clip(shape),
            )
            Text(
                text = "🔍",
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(2.dp)
                    .background(WF.colors.card, CircleShape)
                    .padding(2.dp),
                style = TextStyle(fontSize = 10.sp),
            )
        }

        row.proofExpired -> WaffledStatusBadge(
            text = "📷 gone",
            color = WF.colors.ink3,
            modifier = modifier,
            size = 10.5.sp,
            weight = FontWeight.SemiBold,
        )
    }
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

@Composable
private fun ProofHeader(overline: String, title: String, emoji: String, coin: String?) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(WF.spacing.lg),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text = emoji, style = TextStyle(fontSize = 26.sp))
        ProofHeaderText(overline = overline, title = title, emoji = null, coin = coin)
    }
}

@Composable
private fun ProofHeaderText(overline: String, title: String, emoji: String?, coin: String?) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(text = overline, style = WF.type.bodySmall, color = WF.colors.ink3)
        Row(
            horizontalArrangement = Arrangement.spacedBy(WF.spacing.xs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = if (emoji != null) "$emoji $title" else title,
                style = WF.type.cardTitle,
                color = WF.colors.ink,
            )
            if (coin != null) {
                WaffledStatusBadge(text = coin, color = WF.colors.gold, size = 12.5.sp)
            }
        }
    }
}

/** The proof photo itself, capped so a tall shot can't push the actions off screen. */
@Composable
private fun ProofImage(model: Any?, contentDescription: String) {
    val shape = RoundedCornerShape(WF.radius.md)
    AsyncImage(
        model = model,
        contentDescription = contentDescription,
        contentScale = ContentScale.Fit,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 160.dp, max = 380.dp)
            .clip(shape)
            .border(1.dp, WF.colors.hair, shape),
    )
}

@Composable
private fun ProofPlaceholder(text: String) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 160.dp)
            .background(WF.colors.panel, RoundedCornerShape(WF.radius.md))
            .padding(20.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text,
            style = WF.type.label,
            color = WF.colors.ink3,
            textAlign = TextAlign.Center,
        )
    }
}
