plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.compose.compiler)
}

android {
    namespace = "app.waffled.feature.goalcharts"
    compileSdk = libs.versions.compileSdk.get().toInt()
    defaultConfig {
        minSdk = libs.versions.minSdk.get().toInt()
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
    kotlin { jvmToolchain(libs.versions.jdk.get().toInt()) }
    buildFeatures { compose = true }
}

// This module is PURE PRESENTATION: it draws a `GoalSeries` and nothing else. It
// deliberately has no core:network / core:sync / navigation / serialization dependency —
// there is no fetching here to need one, and the absent dependency is the cheapest
// possible proof of that.
//
// core:model and core:design are api() because both appear in this module's public
// composable signatures (GoalSeries in, Modifier and the WF tokens through).
dependencies {
    api(project(":core:model"))
    api(project(":core:design"))

    testImplementation(project(":core:testing"))
}
