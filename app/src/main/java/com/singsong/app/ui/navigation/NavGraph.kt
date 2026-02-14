package com.singsong.app.ui.navigation

import androidx.compose.runtime.Composable
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.singsong.app.ui.editor.SongEditorScreen
import com.singsong.app.ui.editor.SongEditorViewModel
import com.singsong.app.ui.home.HomeScreen
import com.singsong.app.ui.home.HomeViewModel

sealed class Screen(val route: String) {
    data object Home : Screen("home")
    data object SongEditor : Screen("song_editor/{songId}") {
        fun createRoute(songId: Long) = "song_editor/$songId"
    }
}

@Composable
fun SingSongNavGraph() {
    val navController = rememberNavController()

    NavHost(
        navController = navController,
        startDestination = Screen.Home.route
    ) {
        composable(Screen.Home.route) {
            val viewModel: HomeViewModel = viewModel()
            HomeScreen(
                viewModel = viewModel,
                onNavigateToEditor = { songId ->
                    navController.navigate(Screen.SongEditor.createRoute(songId))
                }
            )
        }

        composable(
            route = Screen.SongEditor.route,
            arguments = listOf(
                navArgument("songId") { type = NavType.LongType }
            )
        ) { backStackEntry ->
            val songId = backStackEntry.arguments?.getLong("songId") ?: return@composable
            val viewModel: SongEditorViewModel = viewModel()
            SongEditorScreen(
                songId = songId,
                viewModel = viewModel,
                onNavigateBack = { navController.popBackStack() }
            )
        }
    }
}
