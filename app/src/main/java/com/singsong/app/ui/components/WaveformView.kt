package com.singsong.app.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.unit.dp

@Composable
fun WaveformView(
    waveformData: List<Float>,
    modifier: Modifier = Modifier,
    color: Color = MaterialTheme.colorScheme.primary,
    backgroundColor: Color = MaterialTheme.colorScheme.surfaceVariant
) {
    Canvas(
        modifier = modifier
            .fillMaxWidth()
            .height(80.dp)
    ) {
        // Draw background
        drawRect(backgroundColor)

        if (waveformData.isEmpty()) return@Canvas

        val centerY = size.height / 2
        val barWidth = size.width / waveformData.size.coerceAtLeast(1)
        val maxBarHeight = size.height / 2

        waveformData.forEachIndexed { index, amplitude ->
            val barHeight = amplitude * maxBarHeight
            val x = index * barWidth + barWidth / 2

            // Draw symmetric waveform bar
            drawLine(
                color = color,
                start = Offset(x, centerY - barHeight),
                end = Offset(x, centerY + barHeight),
                strokeWidth = barWidth.coerceAtMost(4f),
                cap = StrokeCap.Round
            )
        }

        // Draw center line
        drawLine(
            color = color.copy(alpha = 0.3f),
            start = Offset(0f, centerY),
            end = Offset(size.width, centerY),
            strokeWidth = 1f
        )
    }
}

@Composable
fun AudioLevelIndicator(
    level: Float,
    modifier: Modifier = Modifier,
    activeColor: Color = MaterialTheme.colorScheme.primary,
    warningColor: Color = MaterialTheme.colorScheme.secondary,
    inactiveColor: Color = MaterialTheme.colorScheme.surfaceVariant
) {
    Canvas(
        modifier = modifier
            .fillMaxWidth()
            .height(12.dp)
    ) {
        val barCount = 30
        val barWidth = size.width / barCount
        val gap = 2f
        val activeCount = (level * barCount).toInt()

        for (i in 0 until barCount) {
            val color = when {
                i >= activeCount -> inactiveColor
                i > barCount * 0.8 -> warningColor
                else -> activeColor
            }
            drawRect(
                color = color,
                topLeft = Offset(i * barWidth + gap, 0f),
                size = androidx.compose.ui.geometry.Size(barWidth - gap * 2, size.height)
            )
        }
    }
}
