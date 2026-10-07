package app.waffled.android.shell

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.waffled.android.AppContainer
import app.waffled.core.design.WF
import app.waffled.core.design.WaffledEmptyState
import app.waffled.core.model.WaffledModule
import app.waffled.feature.calendar.CalendarScreen
import app.waffled.feature.chores.ChoresScreen
import app.waffled.feature.goalcharts.GoalDataViewSwitcher
import app.waffled.feature.goals.GoalDetailModel
import app.waffled.feature.goals.GoalDetailScreen
import app.waffled.feature.goals.GoalsScreen
import app.waffled.feature.goals.ReviewEventsModel
import app.waffled.feature.goals.ReviewEventsScreen
import app.waffled.feature.lists.ListDetailModel
import app.waffled.feature.lists.ListDetailScreen
import app.waffled.feature.lists.ListsIndexScreen
import app.waffled.feature.meals.MealDetailModel
import app.waffled.feature.meals.MealDetailScreen
import app.waffled.feature.meals.MealsScreen
import app.waffled.feature.pantry.CookHooks
import app.waffled.feature.pantry.PantryModuleGate
import app.waffled.feature.pantry.PantryScreen
import app.waffled.feature.photos.PhotosScreen
import app.waffled.feature.recipes.MealBuilderModel
import app.waffled.feature.recipes.MealBuilderApi
import app.waffled.feature.recipes.MealBuilderScreen
import app.waffled.feature.recipes.PlateRole
import app.waffled.feature.recipes.RecipeDetailModel
import app.waffled.feature.recipes.RecipeDetailScreen
import app.waffled.feature.recipes.RecipeEditorScreen
import app.waffled.feature.recipes.RecipePickerSheet
import app.waffled.feature.recipes.RecipesLibraryScreen
import app.waffled.feature.recipes.toRef
import app.waffled.feature.rewards.RewardEditorSheet
import app.waffled.feature.rewards.RewardShopScreen
import app.waffled.feature.rewards.RewardsAccess
import app.waffled.feature.rewards.RewardsScreen
import app.waffled.feature.bites.WaffledBitesModel
import app.waffled.feature.bites.WaffledBitesScreen
import app.waffled.feature.rhythms.RhythmsScreen
import kotlinx.coroutines.launch

/**
 * Maps a tab root or a pushed [AppRoute] to the feature screen that renders it.
 *
 * This file is why **device verification is the integrator's job, not a feature agent's**:
 * nothing reaches a feature until it is wired here, and the `app` module is outside every
 * feature's ownership.
 */
@Composable
fun TabRoot(
    tabId: String,
    container: AppContainer,
    actions: ShellActions,
    modifier: Modifier = Modifier,
) {
    val modules by container.syncManager.modules.collectAsStateWithLifecycle()
    when (tabId) {
        TAB_TODAY -> TodayHost(container, actions, modifier)
        TAB_CALENDAR -> CalendarScreen(
            model = container.calendarModel,
            countdowns = container.countdownsModel,
            api = container.calendarApi,
            modifier = modifier.padding(bottom = WF.spacing.tabBarClearance),
            mealsEnabled = modules.isOn(WaffledModule.Meals),
        )
        // iOS self-corrects to Today when every flex candidate is off; the bar keeps a
        // placeholder here so the FAB stays centred, and the placeholder says why.
        TAB_FLEX -> when (FlexSlot.resolve(modules)) {
            WaffledModule.Meals -> MealsHost(container, actions, modifier)
            WaffledModule.Goals -> RouteHost(AppRoute.Goals, container, actions, modifier, showBack = false)
            WaffledModule.Chores -> RouteHost(AppRoute.Chores, container, actions, modifier, showBack = false)
            WaffledModule.Lists -> RouteHost(AppRoute.Lists, container, actions, modifier, showBack = false)
            WaffledModule.Pantry -> RouteHost(AppRoute.Pantry, container, actions, modifier, showBack = false)
            else -> WaffledEmptyState(
                emoji = "🧩",
                title = "No modules switched on",
                message = "Turn on Meals, Goals, Chores, Lists or Pantry to fill this tab.",
                modifier = modifier,
            )
        }
        else -> FamilyTab(container, actions, modifier)
    }
}

/** The Meals tab: week / month planners and the recipe library, sharing one recipes model. */
@Composable
private fun MealsHost(container: AppContainer, actions: ShellActions, modifier: Modifier) {
    val weekStart by container.identity.householdWeekStart.collectAsStateWithLifecycle()
    val members by container.syncManager.members.collectAsStateWithLifecycle()
    val library by container.recipesModel.state.collectAsStateWithLifecycle()
    MealsScreen(
        weekModel = container.weekPlannerModel,
        monthModel = container.monthPlannerModel,
        householdWeekStart = weekStart,
        familySize = members.size.coerceAtLeast(1),
        libraryRecipes = remember(library.recipes) { library.recipes.map { it.toRef() } },
        onOpenRecipe = { id ->
            val known = library.recipes.firstOrNull { it.id == id }
            actions.push(AppRoute.Recipe(known ?: Placeholders.recipe(id)))
        },
        onOpenMeal = { actions.push(AppRoute.Meal(it)) },
        recipePicker = { onPick, onDismiss ->
            RecipePickerSheet(
                model = container.recipesModel,
                title = "Pick a recipe",
                onDismiss = onDismiss,
                onPickRecipe = onPick,
            )
        },
        recipesTab = { LibraryHost(container, actions, protein = null, newOnly = false) },
        modifier = modifier.padding(bottom = WF.spacing.tabBarClearance),
        refreshBus = container.refreshBus,
    )
}

@Composable
private fun LibraryHost(
    container: AppContainer,
    actions: ShellActions,
    protein: String?,
    newOnly: Boolean,
    modifier: Modifier = Modifier,
) {
    RecipesLibraryScreen(
        model = container.recipesModel,
        modifier = modifier,
        onOpenRecipe = { actions.push(AppRoute.Recipe(it)) },
        onOpenMeal = { actions.push(AppRoute.Meal(Placeholders.meal(it))) },
        onNewRecipe = { actions.push(AppRoute.RecipeEditor()) },
        onNewMeal = { actions.push(AppRoute.MealBuilder(app.waffled.feature.recipes.MealBuilderStart.Fresh)) },
        initialProtein = protein,
        initialNewOnly = newOnly,
    )
}

/**
 * One pushed screen. [showBack] draws the shell's back row for features that don't draw
 * their own; at a tab root it is off.
 */
@Composable
fun RouteHost(
    route: AppRoute,
    container: AppContainer,
    actions: ShellActions,
    modifier: Modifier = Modifier,
    showBack: Boolean = true,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val members by container.syncManager.members.collectAsStateWithLifecycle()
    val viewer by container.identity.viewer.collectAsStateWithLifecycle()
    val weekStart by container.identity.householdWeekStart.collectAsStateWithLifecycle()
    val modules by container.syncManager.modules.collectAsStateWithLifecycle()
    val zone by container.syncManager.householdZone.collectAsStateWithLifecycle()
    val surfaceRev by container.surfaceRev.collectAsStateWithLifecycle()
    val bottom = Modifier.padding(bottom = WF.spacing.tabBarClearance)

    @Composable
    fun withBack(content: @Composable () -> Unit) {
        if (!showBack) {
            content()
            return
        }
        Column(modifier.fillMaxSize()) {
            BackRow(onBack = actions.pop)
            content()
        }
    }

    when (route) {
        AppRoute.Goals -> withBack {
            GoalsScreen(
                model = container.goalsModel,
                me = viewer,
                members = members,
                onOpenGoal = { actions.push(AppRoute.Goal(it)) },
                modifier = (if (showBack) Modifier else modifier).then(bottom),
            )
        }

        is AppRoute.Goal -> {
            val model = remember(route.goal.id) {
                GoalDetailModel(container.goalsApi, route.goal, container.refreshBus)
            }
            val names = remember(members) { members.associate { it.id to it.name } }
            val emoji = remember(members) { members.associate { it.id to it.displayEmoji } }
            GoalDetailScreen(
                model = model,
                me = viewer,
                onBack = actions.pop,
                modifier = modifier.then(bottom),
                householdWeekStart = weekStart,
                dataView = { series, firstDay ->
                    GoalDataViewSwitcher(
                        series = series,
                        title = route.goal.title,
                        goalType = route.goal.goalType,
                        personNames = names,
                        personEmoji = emoji,
                        firstDay = firstDay,
                    )
                },
            )
        }

        AppRoute.ReviewEvents -> {
            val model = remember { ReviewEventsModel(container.goalsApi, container.refreshBus) }
            ReviewEventsScreen(
                model = model,
                members = members,
                onBack = actions.pop,
                modifier = modifier.then(bottom),
                zone = zone,
            )
        }

        AppRoute.Chores -> withBack {
            ChoresScreen(
                model = container.choresModel,
                members = members,
                viewer = viewer,
                modifier = (if (showBack) Modifier else modifier).then(bottom),
            )
        }

        AppRoute.Rewards -> withBack {
            RewardsScreen(
                model = container.rewardsModel,
                me = viewer,
                modifier = (if (showBack) Modifier else modifier).then(bottom),
            )
        }

        AppRoute.Lists -> withBack {
            ListsIndexScreen(
                model = container.listsModel,
                onOpen = { actions.push(AppRoute.ListDetail(it)) },
                modifier = (if (showBack) Modifier else modifier).then(bottom),
            )
        }

        is AppRoute.ListDetail -> {
            val model = remember(route.list.id) {
                ListDetailModel(route.list, container.listsApi, container.refreshBus)
            }
            ListDetailScreen(
                model = model,
                onBack = actions.pop,
                modifier = modifier.then(bottom),
                onShare = { subject, text -> shareText(context, subject, text) },
                onCopy = { copyText(context, it) },
            )
        }

        AppRoute.Pantry -> withBack {
            PantryModuleGate(gate = modules) {
                PantryScreen(
                    model = container.pantryModel(zone),
                    modifier = (if (showBack) Modifier else modifier).then(bottom),
                    mealsEnabled = modules.isOn(WaffledModule.Meals),
                    hooks = CookHooks(
                        onOpenRecipe = { id, title, emoji, startCooking ->
                            actions.push(AppRoute.Recipe(Placeholders.recipe(id, title, emoji), autoCook = startCooking))
                        },
                        onOpenProteinLibrary = { actions.push(AppRoute.RecipesLibrary(protein = it)) },
                        onAddToGroceryList = { name ->
                            container.listsApi.addGroceryItem(name)
                            container.refreshBus.bump(app.waffled.core.network.RefreshDomain.Lists)
                        },
                    ),
                )
            }
        }

        AppRoute.Photos -> withBack {
            PhotosScreen(
                model = container.photosModel,
                modifier = (if (showBack) Modifier else modifier).then(bottom),
            )
        }

        AppRoute.Settings -> SettingsRoute(container, actions, modifier)

        AppRoute.Approvals -> PageWithBack(onBack = actions.pop, modifier = modifier, title = "Approvals") {
            ApprovalsHost(container)
        }

        AppRoute.Rhythms -> RhythmsScreen(
            model = container.rhythmsModel,
            members = members,
            modifier = modifier,
            refreshKey = surfaceRev,
            onBack = actions.pop,
            onRefreshModules = { container.identity.load() },
            onChanged = container::bumpCountdowns,
        )

        is AppRoute.Person -> PageWithBack(onBack = actions.pop, modifier = modifier) {
            PersonHost(route.personId, container, actions)
        }

        is AppRoute.RewardShop -> PageWithBack(onBack = actions.pop, modifier = modifier) {
            RewardShopHost(route.personId, container, viewer)
        }

        is AppRoute.WaffledBites -> PageWithBack(onBack = actions.pop, modifier = modifier, title = route.personName.ifEmpty { null }) {
            val model = remember(route.personId) { WaffledBitesModel(route.personId, container.bitesApi) }
            WaffledBitesScreen(model = model, personName = route.personName, onUnpaired = actions.pop)
        }

        is AppRoute.Recipe -> {
            val model = remember(route.summary.id) {
                RecipeDetailModel(
                    api = container.recipesApi,
                    summary = route.summary,
                    baseUrl = container.serverAddress.baseUrl(),
                    refreshBus = container.refreshBus,
                    library = container.recipesModel,
                )
            }
            RecipeDetailScreen(
                model = model,
                modifier = modifier,
                onBack = actions.pop,
                onCook = { s ->
                    actions.cook { start(s.recipe.id, s.recipe.title, s.steps, s.ingredients) }
                },
                onEdit = { actions.push(AppRoute.RecipeEditor(it)) },
                onBuildMealAround = {
                    actions.push(AppRoute.MealBuilder(app.waffled.feature.recipes.MealBuilderStart.Around(it)))
                },
                onShare = { md -> shareText(context, md.filename, md.markdown) },
                autoCook = route.autoCook,
                householdWeekStart = weekStart,
            )
        }

        is AppRoute.Meal -> withBack {
            val model = remember(route.meal.id) {
                MealDetailModel(container.mealsApi, route.meal, container.refreshBus)
            }
            MealDetailScreen(
                model = model,
                onOpenRecipe = { id ->
                    val known = container.recipesModel.state.value.recipes.firstOrNull { it.id == id }
                    actions.push(AppRoute.Recipe(known ?: Placeholders.recipe(id)))
                },
                modifier = bottom,
                onCookDish = { dish ->
                    actions.push(
                        AppRoute.Recipe(Placeholders.recipe(dish.recipeId, dish.title.orEmpty(), dish.emoji), autoCook = true),
                    )
                },
            )
        }

        is AppRoute.RecipesLibrary -> withBack {
            LibraryHost(container, actions, route.protein, route.newOnly, bottom)
        }

        is AppRoute.RecipeEditor -> RecipeEditorScreen(
            api = container.recipesApi,
            modifier = modifier,
            editing = route.editing,
            baseUrl = container.serverAddress.baseUrl(),
            onCancel = actions.pop,
            onSaved = { saved ->
                scope.launch { container.recipesModel.load() }
                actions.replaceTop(AppRoute.Recipe(saved))
            },
        )

        is AppRoute.MealBuilder -> {
            val existing = (route.start as? app.waffled.feature.recipes.MealBuilderStart.Editing)?.meal
            val model = remember(route) {
                MealBuilderModel(MealBuilderApi.live(container.recipesApi), existing, container.refreshBus)
            }
            var picking by remember { mutableStateOf<PlateRole?>(null) }
            MealBuilderScreen(
                model = model,
                modifier = modifier,
                start = route.start,
                members = members,
                baseUrl = container.serverAddress.baseUrl(),
                onDone = actions.pop,
                onAddDish = { picking = it },
                onCookPlate = { meal -> actions.cook { startPlate(meal) } },
                householdWeekStart = weekStart,
            )
            picking?.let { role ->
                RecipePickerSheet(
                    model = container.recipesModel,
                    title = role.addLabel,
                    onDismiss = { picking = null },
                    onPickRecipe = { ref -> scope.launch { model.addRecipe(ref.id, role) } },
                    onPickMeal = { id, _ -> scope.launch { model.addSavedMeal(id) } },
                    excludeMealId = model.state.value.meal?.id,
                )
            }
        }
    }
}

/**
 * The shell's back affordance for pushed features that draw no header of their own.
 * Hand-rolled: `core:design` has no navigation-bar component (reported as a gap).
 */
@Composable
internal fun BackRow(onBack: () -> Unit, title: String? = null) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            Modifier
                .clickable(onClick = onBack)
                .padding(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                contentDescription = "Back",
                tint = WF.colors.primary,
                modifier = Modifier.size(20.dp),
            )
            Text("Back", color = WF.colors.primary, style = WF.type.bodySmall, modifier = Modifier.padding(start = 6.dp))
        }
        title?.let {
            Text(it, color = WF.colors.ink, style = WF.type.sectionTitle, maxLines = 1, modifier = Modifier.padding(start = 8.dp))
        }
    }
}

/** One person's reward shop — `canManage` is load-bearing: without it a parent can't redeem in a kid's shop. */
@Composable
private fun RewardShopHost(personId: String, container: AppContainer, viewer: app.waffled.core.model.Person?) {
    var editing by remember { mutableStateOf<app.waffled.feature.rewards.RewardsApi.Reward?>(null) }
    RewardShopScreen(
        personId = personId,
        model = container.rewardsModel,
        canManage = RewardsAccess.canManage(viewer),
        maySpend = RewardsAccess.maySpend(viewer, personId),
        onEdit = { editing = it },
    )
    editing?.let { reward ->
        RewardEditorSheet(
            editing = reward,
            currencies = container.rewardsModel.spendableCurrencies,
            model = container.rewardsModel,
            onDismiss = { editing = null },
        )
    }
}

const val TAB_TODAY = "today"
const val TAB_CALENDAR = "calendar"
const val TAB_FLEX = "flex"
const val TAB_FAMILY = "family"
