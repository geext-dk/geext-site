import catalog from "../../data/projects.json";

export type Project = {
  title: string;
  description: string;
  image: string;
  url?: string;
};

export const projects = catalog.projects as Project[];
