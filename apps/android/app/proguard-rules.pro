# kotlinx.serialization generates serializers off @Serializable — keep them.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class ** {
    *** Companion;
}
-keepclasseswithmembers class ** {
    kotlinx.serialization.KSerializer serializer(...);
}

# PowerSync ships native SQLite bindings reached reflectively.
-keep class com.powersync.** { *; }
