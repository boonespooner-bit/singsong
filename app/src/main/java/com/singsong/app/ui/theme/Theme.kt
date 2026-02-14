package com.singsong.app.ui.theme

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

private val DarkColorScheme = darkColorScheme(
    primary = Color(0xFF6C63FF),
    onPrimary = Color.White,
    primaryContainer = Color(0xFF4A42D4),
    secondary = Color(0xFFFF6584),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFCC5069),
    tertiary = Color(0xFF00D9A3),
    background = Color(0xFF121212),
    surface = Color(0xFF1E1E2E),
    surfaceVariant = Color(0xFF2A2A3C),
    onBackground = Color.White,
    onSurface = Color.White,
    onSurfaceVariant = Color(0xFFB0B0C0),
    error = Color(0xFFFF5252)
)

private val LightColorScheme = lightColorScheme(
    primary = Color(0xFF6C63FF),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFE8E6FF),
    secondary = Color(0xFFFF6584),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFFFE0E6),
    tertiary = Color(0xFF00D9A3),
    background = Color(0xFFF8F8FC),
    surface = Color.White,
    surfaceVariant = Color(0xFFF0F0F8),
    onBackground = Color(0xFF1A1A2E),
    onSurface = Color(0xFF1A1A2E),
    onSurfaceVariant = Color(0xFF666680),
    error = Color(0xFFFF5252)
)

@Composable
fun SingSongTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    val colorScheme = if (darkTheme) DarkColorScheme else LightColorScheme

    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            window.statusBarColor = colorScheme.background.toArgb()
            WindowCompat.getInsetsController(window, view).isAppearanceLightStatusBars = !darkTheme
        }
    }

    MaterialTheme(
        colorScheme = colorScheme,
        content = content
    )
}
