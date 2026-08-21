plugins {
    alias(libs.plugins.android.library)
}

android {
    namespace = "app.waffled.core.testing"
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
}

dependencies {
    api(project(":core:model"))
    api(project(":core:network"))
    api(libs.mockwebserver)
    api(libs.junit)
    api(libs.kotlin.test)
    api(libs.kotlinx.coroutines.test)
    implementation(libs.kotlinx.serialization.json)
}
