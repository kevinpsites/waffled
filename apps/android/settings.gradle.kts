pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "waffled-android"

include(":app")
include(":core:model")
include(":core:design")
include(":core:network")
include(":core:auth")
include(":core:sync")
include(":core:testing")
include(":feature:photos")
include(":feature:calendar")
include(":feature:lists")
include(":feature:chores")
include(":feature:rewards")
include(":feature:today")
include(":feature:meals")
include(":feature:recipes")
include(":feature:goals")
include(":feature:goalcharts")
include(":feature:pantry")
include(":feature:bites")
include(":feature:familynight")
