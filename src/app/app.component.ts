import { Component, inject } from '@angular/core';
import { Router, RouterModule } from '@angular/router';
import { CommonModule } from '@angular/common';
import { Platform } from '@ionic/angular';


import {
  IonApp,
  IonRouterOutlet,
  IonSplitPane,
  IonMenu,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonList,
  IonItem,
  IonIcon,
  IonLabel,
  IonMenuToggle
} from '@ionic/angular/standalone';

import { addIcons } from 'ionicons';
import { archiveOutline, calendarOutline, logOutOutline, createOutline } from 'ionicons/icons';

import { SupabaseService } from './services/supabase.service';

@Component({
  selector: 'app-root',
  templateUrl: 'app.component.html',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    IonApp,
    IonRouterOutlet,
    IonSplitPane,
    IonMenu,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonContent,
    IonList,
    IonItem,
    IonIcon,
    IonLabel,
    IonMenuToggle
  ]
})
export class AppComponent {

  private supabaseService = inject(SupabaseService);
  private router = inject(Router);
  private platform = inject(Platform);

  public appPages = [
    { title: 'Materia Prima', url: '/pages/ingredientes', icon: 'archive' },
    { title: 'Pedidos', url: 'home', icon: 'calendar' },
    { title: 'Generar Cotización', url: '/cotizacion', icon: 'create' }
  ];

  constructor() {
    addIcons({ archiveOutline, calendarOutline, logOutOutline, createOutline });

    this.platform.ready().then(async () => {
      try {
        console.log('APP_INIT: Plataforma lista. Inicializando SQLite...');
        await this.supabaseService.sqliteService.initializeDatabase();
      } catch (e) {
        console.error(
            'APP_INIT: No se pudo inicializar SQLite. Modo online activo.',
            e
        );
      }
    });

  }

  public async logout() {
    try {
      await this.supabaseService.signOut();
    } catch (error) {
      console.error('Error al cerrar sesión:', error);
    }
  }
}