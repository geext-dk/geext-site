export default interface CommonBlogPost {
  data: {
    title: string;
    description: string;
    pubDate: Date;
    updatedDate?: Date;
    draft: boolean;
  };
}
