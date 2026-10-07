plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.compose.compiler)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "app.waffled.android"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        applicationId = "app.waffled"
        minSdk = libs.versions.minSdk.get().toInt()
        targetSdk = libs.versions.targetSdk.get().toInt()
        versionCode = 1
        // ⚠️ Bumped by ./waffled release — see docs/product/android-port-plan.md, Phase 5.
        versionName = "0.13.1"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            // The emulator reaches the host Caddy at 10.0.2.2 — "localhost" from
            // an emulator is the emulator itself.
            buildConfigField("String", "DEFAULT_SERVER_URL", "\"http://10.0.2.2:8080\"")
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            buildConfigField("String", "DEFAULT_SERVER_URL", "\"http://10.0.2.2:8080\"")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
    kotlin { jvmToolchain(libs.versions.jdk.get().toInt()) }

    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    implementation(project(":core:model"))
    implementation(project(":core:design"))
    implementation(project(":core:network"))
    implementation(project(":core:auth"))
    implementation(project(":core:sync"))
    implementation(project(":feature:photos"))
    implementation(project(":feature:chores"))
    implementation(project(":feature:rewards"))
    implementation(project(":feature:today"))
    implementation(project(":feature:calendar"))
    implementation(project(":feature:lists"))
    implementation(project(":feature:goalcharts"))
    implementation(project(":feature:goals"))
    implementation(project(":feature:meals"))
    implementation(project(":feature:recipes"))
    implementation(project(":feature:pantry"))
    implementation(project(":feature:settings"))
    implementation(project(":feature:settingshousehold"))
    implementation(project(":feature:family"))
    implementation(project(":feature:capture"))
    implementation(project(":feature:bites"))
    implementation(project(":feature:familynight"))
    implementation(project(":feature:rhythms"))
    implementation(libs.kotlinx.serialization.json)

    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.core.splashscreen)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)

    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.ui.test.manifest)

    testImplementation(project(":core:testing"))
    androidTestImplementation(libs.androidx.test.junit)
    androidTestImplementation(libs.compose.ui.test.junit4)
}
