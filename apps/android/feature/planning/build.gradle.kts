plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.compose.compiler)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "app.waffled.feature.planning"
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

// Weekly Planning reads every other module, so (uniquely) it may depend on other
// features. All of them are declared up front so the step files can be filled in
// parallel without anyone editing this file.
dependencies {
    implementation(project(":core:model"))
    implementation(project(":core:design"))
    implementation(project(":core:network"))
    implementation(project(":core:sync"))

    implementation(project(":feature:calendar"))
    implementation(project(":feature:goals"))
    implementation(project(":feature:meals"))
    implementation(project(":feature:familynight"))
    implementation(project(":feature:lists"))
    implementation(project(":feature:chores"))
    implementation(project(":feature:recipes"))
    implementation(project(":feature:rewards"))
    implementation(project(":feature:rhythms"))

    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)

    testImplementation(project(":core:testing"))
}
